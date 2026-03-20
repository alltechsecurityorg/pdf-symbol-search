"""Vector path extraction and comparison for CAD symbol matching.

Extracts normalized vector drawing paths from PDF regions using PyMuPDF's
get_drawings() API. Compares symbols structurally via angle histograms and
spatial density grids — resolution-independent and highly accurate for
vector-based CAD drawings.
"""

import fitz
import numpy as np
import json
import logging
import math
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/pdf-symbol-search"))
TEMPLATE_DIR = DATA_DIR / "templates"

# Cache page drawings so we only call get_drawings() once per page
_drawings_cache: dict[str, list] = {}

ANGLE_BINS = 36
GRID_SIZE = 8


def get_page_drawings(pdf_path: str, page_num: int) -> list:
    """Get all vector drawings for a page (cached)."""
    key = f"{pdf_path}:{page_num}"
    if key in _drawings_cache:
        return _drawings_cache[key]

    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    drawings = page.get_drawings()
    doc.close()

    _drawings_cache[key] = drawings
    logger.info(f"Page {page_num}: extracted {len(drawings)} vector paths")
    return drawings


def extract_vector_data(
    pdf_path: str,
    page_num: int,
    x: float,
    y: float,
    w: float,
    h: float,
    drawings: Optional[list] = None,
) -> dict:
    """Extract a vector fingerprint from a PDF region (coordinates in PDF points)."""
    if drawings is None:
        drawings = get_page_drawings(pdf_path, page_num)

    clip = fitz.Rect(x, y, x + w, y + h)
    if clip.width < 0.5 or clip.height < 0.5:
        return {"segment_count": 0, "angle_histogram": [0.0] * ANGLE_BINS, "spatial_grid": _empty_grid()}

    segments = []
    for d in drawings:
        d_rect = d.get("rect")
        if d_rect is None:
            continue
        if not clip.intersects(fitz.Rect(d_rect)):
            continue
        _process_drawing_items(d.get("items", []), clip, segments)

    angle_hist = _make_angle_histogram(segments)
    spatial_grid = _make_spatial_grid(segments)

    return {
        "segment_count": len(segments),
        "angle_histogram": angle_hist,
        "spatial_grid": spatial_grid,
    }


def compare_vector_data(template_data: dict, candidate_data: dict) -> float:
    """Compare two vector fingerprints. Returns similarity in [0, 1]."""
    if not template_data or not candidate_data:
        return 0.0

    t_count = template_data.get("segment_count", 0)
    c_count = candidate_data.get("segment_count", 0)

    if t_count == 0 and c_count == 0:
        return 1.0
    if t_count == 0 or c_count == 0:
        return 0.0

    # 1. Segment count similarity
    max_count = max(t_count, c_count)
    count_sim = 1.0 - abs(t_count - c_count) / max_count

    # 2. Angle histogram similarity (cosine)
    t_a = np.array(template_data["angle_histogram"], dtype=np.float32)
    c_a = np.array(candidate_data["angle_histogram"], dtype=np.float32)
    angle_sim = _cosine_similarity(t_a, c_a)

    # 3. Spatial density grid similarity (cosine)
    t_g = np.array(template_data["spatial_grid"], dtype=np.float32).flatten()
    c_g = np.array(candidate_data["spatial_grid"], dtype=np.float32).flatten()
    spatial_sim = _cosine_similarity(t_g, c_g)

    # Spatial layout matters most, then angle distribution, then count
    return count_sim * 0.20 + angle_sim * 0.35 + spatial_sim * 0.45


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_vector_data(template_id: str, data: dict):
    """Save vector fingerprint to disk alongside the template .npy file."""
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    path = TEMPLATE_DIR / f"{template_id}_vector.json"
    with open(path, "w") as f:
        json.dump(data, f)


def load_vector_data(template_id: str) -> Optional[dict]:
    """Load a previously saved vector fingerprint."""
    path = TEMPLATE_DIR / f"{template_id}_vector.json"
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def clear_drawings_cache():
    _drawings_cache.clear()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _process_drawing_items(items: list, clip: fitz.Rect, out: list):
    """Walk a path's draw commands tracking the current point."""
    current = None
    for item in items:
        cmd = item[0]
        if cmd == "m":
            current = (item[1].x, item[1].y)
        elif cmd == "l" and current is not None:
            end = (item[1].x, item[1].y)
            seg = _normalize_segment(current[0], current[1], end[0], end[1], clip)
            if seg:
                out.append(seg)
            current = end
        elif cmd == "c" and current is not None:
            ctrl1 = (item[1].x, item[1].y)
            ctrl2 = (item[2].x, item[2].y)
            end = (item[3].x, item[3].y)
            _bezier_to_segments(current, ctrl1, ctrl2, end, clip, out)
            current = end
        elif cmd == "re":
            r = item[1]
            corners = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
            for i in range(4):
                j = (i + 1) % 4
                seg = _normalize_segment(
                    corners[i][0], corners[i][1],
                    corners[j][0], corners[j][1],
                    clip,
                )
                if seg:
                    out.append(seg)
            current = (r.x0, r.y0)


def _normalize_segment(x1, y1, x2, y2, clip: fitz.Rect):
    """Normalize a line segment to [0,1] relative to the clip region."""
    cw, ch = clip.width, clip.height
    if cw < 0.1 or ch < 0.1:
        return None

    nx1 = (x1 - clip.x0) / cw
    ny1 = (y1 - clip.y0) / ch
    nx2 = (x2 - clip.x0) / cw
    ny2 = (y2 - clip.y0) / ch

    length = math.hypot(nx2 - nx1, ny2 - ny1)
    if length < 0.005:
        return None

    angle = math.atan2(ny2 - ny1, nx2 - nx1)
    mid_x = (nx1 + nx2) / 2
    mid_y = (ny1 + ny2) / 2

    return {"angle": angle, "length": length, "mid_x": mid_x, "mid_y": mid_y}


def _bezier_to_segments(p0, ctrl1, ctrl2, p3, clip, out, subdivisions=8):
    """Approximate a cubic bezier with line segments."""
    prev = p0
    for i in range(1, subdivisions + 1):
        t = i / subdivisions
        u = 1 - t
        x = (u ** 3 * p0[0] + 3 * u ** 2 * t * ctrl1[0]
             + 3 * u * t ** 2 * ctrl2[0] + t ** 3 * p3[0])
        y = (u ** 3 * p0[1] + 3 * u ** 2 * t * ctrl1[1]
             + 3 * u * t ** 2 * ctrl2[1] + t ** 3 * p3[1])
        seg = _normalize_segment(prev[0], prev[1], x, y, clip)
        if seg:
            out.append(seg)
        prev = (x, y)


def _make_angle_histogram(segments: list) -> list[float]:
    """Histogram of line angles weighted by length."""
    hist = [0.0] * ANGLE_BINS
    total = sum(s["length"] for s in segments)
    if total < 1e-6:
        return hist
    for seg in segments:
        angle = seg["angle"] % math.pi  # direction-agnostic
        idx = int(angle / math.pi * ANGLE_BINS) % ANGLE_BINS
        hist[idx] += seg["length"] / total
    return hist


def _make_spatial_grid(segments: list) -> list[list[float]]:
    """Spatial density grid of segment midpoints weighted by length."""
    grid = [[0.0] * GRID_SIZE for _ in range(GRID_SIZE)]
    if not segments:
        return grid
    for seg in segments:
        gx = max(0, min(int(seg["mid_x"] * GRID_SIZE), GRID_SIZE - 1))
        gy = max(0, min(int(seg["mid_y"] * GRID_SIZE), GRID_SIZE - 1))
        grid[gy][gx] += seg["length"]
    total = sum(sum(row) for row in grid)
    if total > 0:
        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                grid[r][c] /= total
    return grid


def _empty_grid() -> list[list[float]]:
    return [[0.0] * GRID_SIZE for _ in range(GRID_SIZE)]


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a < 1e-8 or norm_b < 1e-8:
        return 0.0
    return float(max(0.0, np.dot(a, b) / (norm_a * norm_b)))
