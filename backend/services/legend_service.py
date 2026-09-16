"""Split a boxed legend region into individual legend entries.

Geometry-first: legend rows are separated by vertical whitespace, and within a row the
glyph is the leftmost cluster of strokes before the first horizontal gap (descriptions -
outlined or real text - sit to the right). Real words overlapping a row become its name;
sheets whose descriptions are outlined vectors yield unnamed entries to rename inline.
Works on one column/section per box - box each legend section separately.
"""
import logging

import numpy as np

from services.vector_match import load_index
from services.crop_service import crop_symbol
from services.pdf_service import get_pdf_path

logger = logging.getLogger(__name__)

MAX_GLYPH_SEG = 60.0   # pt; longer segments are rules/borders, not glyph strokes
ROW_GAP = 2.5          # pt of clear vertical space that separates rows
COL_GAP = 5.0          # pt of clear horizontal space that ends the glyph cluster
PAD = 0.7


def _merge_intervals(ivals: list[tuple[float, float]], gap: float) -> list[tuple[float, float]]:
    ivals = sorted(ivals)
    out = [list(ivals[0])]
    for lo, hi in ivals[1:]:
        if lo <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return [tuple(v) for v in out]


def extract_legend(pdf_id: str, x: float, y: float, w: float, h: float) -> list[dict]:
    idx = load_index(pdf_id)
    seg = idx["seg"]
    ln = np.hypot(seg[:, 2] - seg[:, 0], seg[:, 3] - seg[:, 1])
    m = ((ln <= MAX_GLYPH_SEG)
         & (np.minimum(seg[:, 0], seg[:, 2]) >= x) & (np.maximum(seg[:, 0], seg[:, 2]) <= x + w)
         & (np.minimum(seg[:, 1], seg[:, 3]) >= y) & (np.maximum(seg[:, 1], seg[:, 3]) <= y + h))
    s = seg[m]
    if len(s) == 0:
        return []

    # rows = vertical bands of geometry
    bands = _merge_intervals([(min(a[1], a[3]), max(a[1], a[3])) for a in s], ROW_GAP)

    pdf_path = str(get_pdf_path(pdf_id))
    out = []
    for y0, y1 in bands:
        if y1 - y0 < 2.5 or y1 - y0 > 60:
            continue
        band = s[(np.minimum(s[:, 1], s[:, 3]) >= y0 - 0.1) & (np.maximum(s[:, 1], s[:, 3]) <= y1 + 0.1)]
        if len(band) < 2:
            continue
        # glyph = leftmost horizontal cluster (outlined description text clusters further right)
        xiv = _merge_intervals([(min(a[0], a[2]), max(a[0], a[2])) for a in band], COL_GAP)
        gx0, gx1 = xiv[0]
        gm = ((np.minimum(band[:, 0], band[:, 2]) >= gx0 - 0.1) & (np.maximum(band[:, 0], band[:, 2]) <= gx1 + 0.1))
        g = band[gm]
        ys = np.concatenate([g[:, 1], g[:, 3]])
        gy0, gy1 = float(ys.min()), float(ys.max())
        if gx1 - gx0 < 2 or gy1 - gy0 < 2 or gx1 - gx0 > 120 or gy1 - gy0 > 60:
            continue
        # name = real words overlapping the row, right of the glyph (may be outside the drag box)
        words = [wd for wd in idx["words"] if wd[1] < gy1 + 1 and wd[3] > gy0 - 1 and gx1 - 1 <= wd[0] <= gx1 + 300]
        words.sort(key=lambda wd: wd[0])
        name = " ".join(str(wd[4]) for wd in words).strip()[:60]
        tpl = crop_symbol(pdf_path, 1, gx0 - PAD, gy0 - PAD, (gx1 - gx0) + 2 * PAD, (gy1 - gy0) + 2 * PAD)
        out.append({
            "template_id": tpl["template_id"],
            "thumbnail_base64": tpl["thumbnail_base64"],
            "name": name,
            "crop": {"page": 1, "x": gx0 - PAD, "y": gy0 - PAD, "width": (gx1 - gx0) + 2 * PAD, "height": (gy1 - gy0) + 2 * PAD},
        })
    logger.info("legend extract %s: %d bands -> %d entries", pdf_id, len(bands), len(out))
    return out
