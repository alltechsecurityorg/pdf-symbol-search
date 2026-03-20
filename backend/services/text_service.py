import fitz
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

LABEL_SEARCH_PADDING = 0.5  # Expand bounding box by 50% on each side for label search

# ---------------------------------------------------------------------------
# Efficient page-level text extraction (extract once, query many times)
# ---------------------------------------------------------------------------

_text_block_cache: dict[str, list[dict]] = {}


def get_page_text_blocks(pdf_path: str, page_num: int) -> list[dict]:
    """Extract all text blocks with positions from a page (cached).

    Returns a list of dicts with keys: x0, y0, x1, y1, text.
    Coordinates are in PDF points (72 DPI).
    """
    key = f"{pdf_path}:{page_num}"
    if key in _text_block_cache:
        return _text_block_cache[key]

    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    raw_blocks = page.get_text("blocks")
    doc.close()

    blocks = []
    for b in raw_blocks:
        # block format: (x0, y0, x1, y1, text, block_no, block_type)
        block_type = b[6] if len(b) > 6 else 0
        if block_type != 0:
            continue
        text = re.sub(r"\s+", " ", str(b[4])).strip()
        if text:
            blocks.append({"x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3], "text": text})

    _text_block_cache[key] = blocks
    logger.info(f"Page {page_num}: extracted {len(blocks)} text blocks")
    return blocks


def text_in_rect(blocks: list[dict], x: float, y: float, w: float, h: float) -> str:
    """Get text from pre-extracted blocks that falls within a rectangle."""
    rx1, ry1 = x + w, y + h
    texts = []
    for b in blocks:
        if b["x1"] > x and b["x0"] < rx1 and b["y1"] > y and b["y0"] < ry1:
            texts.append(b["text"])
    return re.sub(r"\s+", " ", " ".join(texts)).strip()


def clear_text_cache():
    _text_block_cache.clear()


def extract_text_in_rect(
    pdf_path: str, page_num: int, x: float, y: float, w: float, h: float
) -> str:
    """Extract vector text from a specific rectangle on a PDF page (PDF points)."""
    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    clip = fitz.Rect(x, y, x + w, y + h)
    text = page.get_text("text", clip=clip)
    doc.close()
    return re.sub(r"\s+", " ", text).strip()


def extract_text_near_rect(
    pdf_path: str, page_num: int, x: float, y: float, w: float, h: float,
    padding: float = LABEL_SEARCH_PADDING,
) -> str:
    """Extract vector text from an expanded region around a rectangle,
    excluding text that falls inside the inner rect."""
    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]

    pad_x = w * padding
    pad_y = h * padding
    outer = fitz.Rect(
        max(0, x - pad_x),
        max(0, y - pad_y),
        min(page.rect.width, x + w + pad_x),
        min(page.rect.height, y + h + pad_y),
    )
    inner = fitz.Rect(x, y, x + w, y + h)

    blocks = page.get_text("blocks", clip=outer)
    doc.close()

    nearby_texts = []
    for block in blocks:
        bx0, by0, bx1, by1, text = block[0], block[1], block[2], block[3], block[4]
        block_type = block[6] if len(block) > 6 else 0
        if block_type != 0:
            continue
        block_rect = fitz.Rect(bx0, by0, bx1, by1)
        if inner.contains(block_rect):
            continue
        nearby_texts.append(text.strip())

    combined = " ".join(nearby_texts)
    return re.sub(r"\s+", " ", combined).strip()


def extract_text_at_crop(
    pdf_path: str, page_num: int, x: float, y: float, w: float, h: float
) -> dict:
    """Extract both inner and nearby text for a crop region.
    Called during the crop workflow."""
    inner = extract_text_in_rect(pdf_path, page_num, x, y, w, h)
    label = extract_text_near_rect(pdf_path, page_num, x, y, w, h)
    return {"inner_text": inner or None, "label_text": label or None}


def compute_text_score(
    found_inner: str,
    found_label: str,
    expected_inner: Optional[str],
    expected_label: Optional[str],
) -> float:
    """Compute a text matching score in [0.0, 1.0].
    Returns 1.0 when no text patterns are configured (no penalty)."""
    scores = []

    if expected_inner:
        scores.append(_match_text(found_inner, expected_inner))
    if expected_label:
        scores.append(_match_text(found_label, expected_label))

    if not scores:
        return 1.0

    return sum(scores) / len(scores)


def _match_text(found: str, expected: str) -> float:
    """Score a single text comparison: exact=1.0, substring=0.7, miss=0.0."""
    if not found:
        return 0.0

    found_lower = found.lower()
    expected_lower = expected.lower()

    if found_lower == expected_lower:
        return 1.0
    if expected_lower in found_lower or found_lower in expected_lower:
        return 0.7
    return 0.0
