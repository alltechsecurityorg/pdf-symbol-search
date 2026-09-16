import fitz
import cv2
import numpy as np
from PIL import Image
import io
import base64
import uuid
from pathlib import Path
import os

from utils.coordinates import RENDER_DPI, SCALE_FACTOR
from services.vector_service import extract_vector_data, save_vector_data
from services.text_service import extract_text_in_rect
from services.vector_match import template_geometry, save_geometry

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/pdf-symbol-search"))
TEMPLATE_DIR = DATA_DIR / "templates"
TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)


def crop_symbol(pdf_path: str, page_num: int, x: float, y: float, w: float, h: float) -> dict:
    template_id = f"tpl_{uuid.uuid4().hex[:8]}"

    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]

    clip_rect = fitz.Rect(x, y, x + w, y + h)
    matrix = fitz.Matrix(SCALE_FACTOR, SCALE_FACTOR)
    pixmap = page.get_pixmap(matrix=matrix, clip=clip_rect)

    img_array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
        pixmap.height, pixmap.width, pixmap.n
    )

    if pixmap.n == 4:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGBA2GRAY)
    elif pixmap.n == 3:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_array.copy()

    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    doc.close()

    template_path = TEMPLATE_DIR / f"{template_id}.npy"
    np.save(str(template_path), binary)

    pil_image = Image.fromarray(binary)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    base64_str = base64.b64encode(buffer.getvalue()).decode()

    # Extract and save vector drawing data + inner text for matching
    vector_data = extract_vector_data(pdf_path, page_num, x, y, w, h)
    inner_text = extract_text_in_rect(pdf_path, page_num, x, y, w, h)
    if inner_text:
        vector_data["inner_text"] = inner_text
    save_vector_data(template_id, vector_data)
    try:
        geom = template_geometry(Path(pdf_path).stem, x, y, w, h)
        save_geometry(template_id, geom)
    except Exception:  # noqa: BLE001 - raster matching still works without geometry
        import logging; logging.getLogger(__name__).exception("template geometry failed")

    return {
        "template_id": template_id,
        "thumbnail_base64": f"data:image/png;base64,{base64_str}",
        "pixel_width": binary.shape[1],
        "pixel_height": binary.shape[0],
    }


def get_template(template_id: str) -> np.ndarray:
    template_path = TEMPLATE_DIR / f"{template_id}.npy"
    if not template_path.exists():
        raise FileNotFoundError(f"Template {template_id} not found")
    return np.load(str(template_path))
