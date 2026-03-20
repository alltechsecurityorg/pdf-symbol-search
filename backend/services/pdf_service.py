import fitz
import os
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/pdf-symbol-search"))
PDF_DIR = DATA_DIR / "pdfs"
PDF_DIR.mkdir(parents=True, exist_ok=True)


def save_pdf(file_content: bytes, filename: str) -> dict:
    pdf_id = str(uuid.uuid4())[:8]
    filepath = PDF_DIR / f"{pdf_id}.pdf"
    filepath.write_bytes(file_content)

    doc = fitz.open(str(filepath))
    page_sizes = []
    for i in range(doc.page_count):
        page = doc[i]
        rect = page.rect
        page_sizes.append({
            "page": i + 1,
            "width_pts": round(rect.width, 1),
            "height_pts": round(rect.height, 1),
        })
    doc.close()

    return {
        "pdf_id": pdf_id,
        "filename": filename,
        "page_count": len(page_sizes),
        "page_sizes": page_sizes,
    }


def get_pdf_path(pdf_id: str) -> Path:
    filepath = PDF_DIR / f"{pdf_id}.pdf"
    if not filepath.exists():
        raise FileNotFoundError(f"PDF {pdf_id} not found")
    return filepath
