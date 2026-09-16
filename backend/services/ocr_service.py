"""OCR for outlined (vectorised) text: legend descriptions and symbol code letters.

Tesseract over high-DPI clip renders. Only used where the PDF has no real text layer
for the region - real words are always preferred.
"""
import logging
import re

import cv2
import numpy as np
import pytesseract

from services.pdf_service import render_clip

logger = logging.getLogger(__name__)


def _img(pdf_id: str, x: float, y: float, w: float, h: float, z: float):
    png = render_clip(pdf_id, x, y, w, h, z, pad=0.5)
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    # tesseract likes clean bilevel text with some margin
    _, bw = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.copyMakeBorder(bw, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)


def read_line(pdf_id: str, x: float, y: float, w: float, h: float) -> str:
    """One line of description text (legend rows)."""
    try:
        img = _img(pdf_id, x, y, w, h, z=max(4.0, min(16.0, 60.0 / max(h, 1e-6))))
        txt = pytesseract.image_to_string(img, config="--psm 7 --oem 1").strip()
        txt = re.sub(r"[^A-Za-z0-9 ()./&,'\-]", "", txt)
        return re.sub(r"\s+", " ", txt).strip()
    except Exception:  # noqa: BLE001
        logger.exception("ocr read_line failed")
        return ""


def read_code(pdf_id: str, x: float, y: float, w: float, h: float) -> str:
    """Short uppercase code inside a boxed symbol (ES, CR, KP...)."""
    try:
        img = _img(pdf_id, x, y, w, h, z=max(8.0, min(32.0, 220.0 / max(h, 1e-6))))
        best = ""
        for psm in (7, 8, 6):
            txt = pytesseract.image_to_string(
                img, config=f"--psm {psm} --oem 1 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
            c = re.sub(r"[^A-Z0-9]", "", txt.upper())
            if 1 <= len(c) <= 5:
                best = c; break
        txt = best
        return txt
    except Exception:  # noqa: BLE001
        logger.exception("ocr read_code failed")
        return ""
