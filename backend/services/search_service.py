import cv2
import numpy as np
import fitz
import time
import logging
from typing import Optional

from utils.coordinates import RENDER_DPI, SCALE_FACTOR
from services.crop_service import get_template
from services.vector_service import (
    extract_vector_data, compare_vector_data,
    load_vector_data, get_page_drawings, clear_drawings_cache,
)
from services.text_service import get_page_text_blocks, text_in_rect, clear_text_cache

logger = logging.getLogger(__name__)

# Cache: key -> (binary, grayscale, edges, scale_factor)
_page_cache: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray, float]] = {}

MAX_RENDER_DIM = 6000

# Padding ratio added around templates for context matching
TEMPLATE_PAD_RATIO = 0.15


def _cache_key(pdf_path: str, page_num: int) -> str:
    return f"{pdf_path}:{page_num}"


def _compute_scale_factor(pdf_path: str, page_num: int) -> float:
    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    rect = page.rect
    doc.close()

    target_w = rect.width * SCALE_FACTOR
    target_h = rect.height * SCALE_FACTOR

    if target_w > MAX_RENDER_DIM or target_h > MAX_RENDER_DIM:
        ratio = min(MAX_RENDER_DIM / target_w, MAX_RENDER_DIM / target_h)
        effective = SCALE_FACTOR * ratio
        logger.info(
            f"Large page {page_num} ({rect.width/72:.0f}x{rect.height/72:.0f} in), "
            f"capping to {effective*72:.0f} DPI"
        )
        return effective
    return SCALE_FACTOR


def render_page(pdf_path: str, page_num: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """Render page to binary, grayscale, and edge images. Returns (binary, gray, edges, scale)."""
    key = _cache_key(pdf_path, page_num)
    if key in _page_cache:
        return _page_cache[key]

    scale_factor = _compute_scale_factor(pdf_path, page_num)

    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    matrix = fitz.Matrix(scale_factor, scale_factor)
    pixmap = page.get_pixmap(matrix=matrix)

    img = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
        pixmap.height, pixmap.width, pixmap.n
    )

    if pixmap.n >= 3:
        gray = cv2.cvtColor(
            img, cv2.COLOR_RGB2GRAY if pixmap.n == 3 else cv2.COLOR_RGBA2GRAY
        )
    else:
        gray = img.copy()

    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edges = cv2.Canny(gray, 50, 150)

    doc.close()

    _page_cache[key] = (binary, gray, edges, scale_factor)
    logger.info(
        f"Page {page_num} rendered: {binary.shape[1]}x{binary.shape[0]} px "
        f"(scale={scale_factor:.3f}, DPI={scale_factor*72:.0f})"
    )
    return binary, gray, edges, scale_factor


# Keep backward compat for main.py SSE endpoint
def render_page_binary(pdf_path: str, page_num: int) -> tuple[np.ndarray, float]:
    binary, _, _, scale = render_page(pdf_path, page_num)
    return binary, scale


def rescale_template(template: np.ndarray, template_scale: float, page_scale: float) -> np.ndarray:
    if abs(template_scale - page_scale) < 0.01:
        return template
    ratio = page_scale / template_scale
    new_w = max(int(template.shape[1] * ratio), 5)
    new_h = max(int(template.shape[0] * ratio), 5)
    return cv2.resize(template, (new_w, new_h), interpolation=cv2.INTER_AREA)


def add_padding(template: np.ndarray, pad_ratio: float) -> np.ndarray:
    """Add white padding around template to include surrounding context."""
    h, w = template.shape[:2]
    pad_x = int(w * pad_ratio)
    pad_y = int(h * pad_ratio)
    return cv2.copyMakeBorder(
        template, pad_y, pad_y, pad_x, pad_x,
        cv2.BORDER_CONSTANT, value=255
    )


def classify_template(template: np.ndarray) -> str:
    """
    Classify a template as 'text-in-box' or 'graphical' based on its
    interior content characteristics.

    text-in-box: rectangular outline with text/content inside (RS, KP, SEC)
      → interior matching is critical to distinguish them
    graphical: distinctive overall shape (camera, sensor, valve)
      → shape/template matching is more important

    Returns 'text-in-box' or 'graphical'.
    """
    h, w = template.shape[:2]
    if h < 10 or w < 10:
        return "graphical"

    _, binary = cv2.threshold(template, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    ink = (binary < 128)  # True where ink is

    # Check if the border has significantly more ink than the interior
    margin = 0.20
    mx = max(int(w * margin), 2)
    my = max(int(h * margin), 2)

    border_mask = np.zeros_like(ink)
    border_mask[:my, :] = True
    border_mask[h - my:, :] = True
    border_mask[:, :mx] = True
    border_mask[:, w - mx:] = True

    interior_mask = ~border_mask

    border_ink = ink[border_mask].sum() / max(border_mask.sum(), 1)
    interior_ink = ink[interior_mask].sum() / max(interior_mask.sum(), 1)

    # Text-in-box: strong border with moderate interior content
    # Graphical: ink distributed throughout, or distinctive shape without clear box
    border_ratio = border_ink / max(interior_ink, 0.001)

    # Check edge straightness — boxes have lots of straight horizontal/vertical edges
    edges = cv2.Canny(template, 50, 150)
    # Check if edges concentrate along the border
    border_edges = edges[border_mask].sum() / max(border_mask.sum(), 1)
    interior_edges = edges[interior_mask].sum() / max(interior_mask.sum(), 1)

    # A text-in-box has: high border ink, border edges >> interior edges,
    # and the interior has some content (not blank)
    is_boxy = (
        border_ratio > 1.5
        and border_edges > interior_edges * 1.2
        and interior_ink > 0.01  # has some content inside
    )

    return "text-in-box" if is_boxy else "graphical"


def compute_orb_similarity(region: np.ndarray, template: np.ndarray) -> float:
    """
    Compare region and template using ORB feature matching.
    Good for distinctive graphical symbols (cameras, sensors, valves).
    Returns a similarity score in [0, 1].
    """
    # Resize region to match template
    if region.shape != template.shape:
        region = cv2.resize(region, (template.shape[1], template.shape[0]),
                            interpolation=cv2.INTER_AREA)

    # Ensure 8-bit grayscale
    if region.dtype != np.uint8:
        region = region.astype(np.uint8)
    if template.dtype != np.uint8:
        template = template.astype(np.uint8)

    orb = cv2.ORB_create(nfeatures=100)

    kp1, des1 = orb.detectAndCompute(template, None)
    kp2, des2 = orb.detectAndCompute(region, None)

    if des1 is None or des2 is None or len(kp1) < 2 or len(kp2) < 2:
        return 0.5  # Not enough features to compare

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    try:
        matches = bf.knnMatch(des1, des2, k=2)
    except cv2.error:
        return 0.5

    # Lowe's ratio test
    good_matches = []
    for m_pair in matches:
        if len(m_pair) == 2:
            m, n = m_pair
            if m.distance < 0.75 * n.distance:
                good_matches.append(m)

    if len(kp1) == 0:
        return 0.5

    # Score: ratio of good matches to total keypoints
    match_ratio = len(good_matches) / len(kp1)
    # Also consider average distance of good matches
    if good_matches:
        avg_dist = sum(m.distance for m in good_matches) / len(good_matches)
        dist_score = max(0, 1.0 - avg_dist / 256.0)  # ORB max distance is 256
    else:
        dist_score = 0.0

    return min(1.0, match_ratio * 0.6 + dist_score * 0.4)


def compute_interior_similarity(region: np.ndarray, template: np.ndarray, margin: float = 0.20) -> float:
    """
    Compare the INTERIOR content of a candidate region against the template,
    cropping away the border/outline by `margin` ratio from each edge.

    This is critical for distinguishing symbols that have identical outer
    structure (e.g. same-size rectangles) but different interior content
    (e.g. "RS" vs "KP" text rendered as pixels).
    """
    # Resize region to match template
    if region.shape != template.shape:
        region = cv2.resize(region, (template.shape[1], template.shape[0]),
                            interpolation=cv2.INTER_AREA)

    h, w = template.shape[:2]
    mx = max(int(w * margin), 2)
    my = max(int(h * margin), 2)

    # Ensure we have enough interior pixels to compare
    inner_w = w - 2 * mx
    inner_h = h - 2 * my
    if inner_w < 4 or inner_h < 4:
        return 0.5  # Too small to compare interiors meaningfully

    tpl_inner = template[my:h - my, mx:w - mx]
    reg_inner = region[my:h - my, mx:w - mx]

    # Binarize both
    _, bin_tpl = cv2.threshold(tpl_inner, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, bin_reg = cv2.threshold(reg_inner, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Convert to float: ink=1, background=0
    t = (255 - bin_tpl).astype(np.float32) / 255.0
    r = (255 - bin_reg).astype(np.float32) / 255.0

    # 1. NCC on interior pixels
    t_mean, r_mean = t.mean(), r.mean()
    t_std, r_std = t.std(), r.std()

    if t_std < 1e-6 or r_std < 1e-6:
        # One of them is blank interior — score by whether both are blank
        if t_std < 1e-6 and r_std < 1e-6:
            ncc = 1.0  # Both blank interiors
        else:
            ncc = 0.0  # One has content, the other doesn't
    else:
        ncc = ((r - r_mean) * (t - t_mean)).mean() / (r_std * t_std)
        ncc = max(0, ncc)

    # 2. Pixel agreement ratio (what fraction of interior pixels match)
    agreement = (bin_tpl == bin_reg).sum() / bin_tpl.size

    # 3. Template match on just the interior
    if tpl_inner.shape[0] >= 4 and tpl_inner.shape[1] >= 4:
        # Use smaller region as template for matchTemplate
        res = cv2.matchTemplate(reg_inner, tpl_inner, cv2.TM_CCOEFF_NORMED)
        tm_interior = float(res[0, 0]) if res.size > 0 else 0.0
        tm_interior = max(0, tm_interior)
    else:
        tm_interior = ncc

    return ncc * 0.40 + agreement * 0.25 + tm_interior * 0.35


def compute_shape_similarity(region: np.ndarray, template: np.ndarray) -> float:
    """
    Compare the shape structure of a candidate region against the template.
    Uses edge + contour analysis for shape-aware comparison rather than
    just pixel density.
    """
    # Resize region to match template size
    if region.shape != template.shape:
        region = cv2.resize(region, (template.shape[1], template.shape[0]),
                            interpolation=cv2.INTER_AREA)

    # 1. Edge similarity — compare Canny edges
    edges_region = cv2.Canny(region, 50, 150)
    edges_template = cv2.Canny(template, 50, 150)

    # Dilate edges slightly so near-matches count
    kernel = np.ones((3, 3), np.uint8)
    edges_region_d = cv2.dilate(edges_region, kernel, iterations=1)
    edges_template_d = cv2.dilate(edges_template, kernel, iterations=1)

    # Compute overlap of edges
    if edges_template.sum() == 0:
        return 0.0

    # How many template edges are covered by region edges
    overlap = np.logical_and(edges_template > 0, edges_region_d > 0).sum()
    template_edge_count = (edges_template > 0).sum()
    recall = overlap / template_edge_count if template_edge_count > 0 else 0

    # How many region edges are covered by template edges (penalize extra edges)
    region_edge_count = (edges_region > 0).sum()
    reverse_overlap = np.logical_and(edges_region > 0, edges_template_d > 0).sum()
    precision = reverse_overlap / region_edge_count if region_edge_count > 0 else 0

    # F1-like score
    if recall + precision == 0:
        edge_score = 0.0
    else:
        edge_score = 2 * recall * precision / (recall + precision)

    # 2. Ink density similarity — compare ratio of black pixels
    tpl_ink = (template < 128).sum() / template.size
    reg_ink = (region < 128).sum() / region.size
    density_diff = abs(tpl_ink - reg_ink)
    density_score = max(0, 1.0 - density_diff * 5)  # Penalize >20% density difference

    # 3. Pixel-level normalized cross-correlation on binarized
    _, bin_region = cv2.threshold(region, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, bin_template = cv2.threshold(template, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Invert so ink=1 background=0
    r = (255 - bin_region).astype(np.float32) / 255.0
    t = (255 - bin_template).astype(np.float32) / 255.0

    r_mean = r.mean()
    t_mean = t.mean()
    r_std = r.std()
    t_std = t.std()

    if r_std < 1e-6 or t_std < 1e-6:
        ncc_score = 0.0
    else:
        ncc = ((r - r_mean) * (t - t_mean)).mean() / (r_std * t_std)
        ncc_score = max(0, ncc)

    # Combined score: edge shape matters most, then pixel correlation, then density
    combined = edge_score * 0.45 + ncc_score * 0.40 + density_score * 0.15
    return combined


def match_symbol_on_page(
    page_binary: np.ndarray,
    page_gray: np.ndarray,
    template_binary: np.ndarray,
    confidence_threshold: float,
    scales: Optional[list[float]] = None,
    rotations: Optional[list[int]] = None,
    pdf_path: Optional[str] = None,
    page_num: Optional[int] = None,
    page_scale: Optional[float] = None,
    template_vector_data: Optional[dict] = None,
    page_drawings: Optional[list] = None,
    template_inner_text: Optional[str] = None,
    page_text_blocks: Optional[list] = None,
) -> list[dict]:
    if scales is None:
        scales = [0.95, 1.0, 1.05]
    if rotations is None:
        rotations = [0, 90, 180, 270]

    # Add padding to template for context-aware matching
    padded_template = add_padding(template_binary, TEMPLATE_PAD_RATIO)

    # Permissive enough to catch matches, tight enough to stay fast
    candidate_threshold = max(confidence_threshold - 0.15, 0.40)

    all_candidates = []

    for rotation in rotations:
        if rotation == 0:
            rotated = padded_template
            rotated_raw = template_binary
        elif rotation == 90:
            rotated = cv2.rotate(padded_template, cv2.ROTATE_90_CLOCKWISE)
            rotated_raw = cv2.rotate(template_binary, cv2.ROTATE_90_CLOCKWISE)
        elif rotation == 180:
            rotated = cv2.rotate(padded_template, cv2.ROTATE_180)
            rotated_raw = cv2.rotate(template_binary, cv2.ROTATE_180)
        elif rotation == 270:
            rotated = cv2.rotate(padded_template, cv2.ROTATE_90_COUNTERCLOCKWISE)
            rotated_raw = cv2.rotate(template_binary, cv2.ROTATE_90_COUNTERCLOCKWISE)
        else:
            continue

        for scale in scales:
            scaled_w = int(rotated.shape[1] * scale)
            scaled_h = int(rotated.shape[0] * scale)

            if scaled_w >= page_binary.shape[1] or scaled_h >= page_binary.shape[0]:
                continue
            if scaled_w < 10 or scaled_h < 10:
                continue

            scaled = cv2.resize(rotated, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA)

            # Stage 1: Fast template match on binary image
            result = cv2.matchTemplate(page_binary, scaled, cv2.TM_CCOEFF_NORMED)
            locations = np.where(result >= candidate_threshold)

            # Compute the actual symbol region (without padding) within the padded match
            raw_w = int(rotated_raw.shape[1] * scale)
            raw_h = int(rotated_raw.shape[0] * scale)
            pad_x = (scaled_w - raw_w) // 2
            pad_y = (scaled_h - raw_h) // 2

            for pt_y, pt_x in zip(*locations):
                all_candidates.append({
                    "x_px": int(pt_x) + pad_x,
                    "y_px": int(pt_y) + pad_y,
                    "w_px": raw_w,
                    "h_px": raw_h,
                    "tm_confidence": float(result[pt_y, pt_x]),
                    "scale": scale,
                    "rotation": rotation,
                    "template_raw": rotated_raw,
                })

    # NMS on candidates first to reduce validation work
    candidates = non_maximum_suppression_candidates(all_candidates, overlap_threshold=0.3)
    logger.info(f"Stage 1: {len(all_candidates)} raw hits → {len(candidates)} after NMS")

    # Check if vector matching is available
    has_vector = (
        template_vector_data is not None
        and template_vector_data.get("segment_count", 0) > 0
        and pdf_path and page_num and page_scale
    )

    # Classify the template ONCE to choose the right scoring strategy.
    # text-in-box: interior matching dominates (distinguish RS vs KP)
    # graphical: shape + ORB + template match dominate (distinguish camera vs sensor)
    tpl_type = classify_template(template_binary)
    logger.info(f"Template classified as '{tpl_type}'")

    # Stage 2: Validate each candidate with adaptive scoring
    validated = []
    for c in candidates:
        x, y, w, h = c["x_px"], c["y_px"], c["w_px"], c["h_px"]

        # Bounds check
        if y < 0 or x < 0 or y + h > page_gray.shape[0] or x + w > page_gray.shape[1]:
            continue

        region = page_gray[y:y+h, x:x+w]
        tpl_raw = c["template_raw"]

        # Resize template to match region size for comparison
        tpl_resized = cv2.resize(tpl_raw, (w, h), interpolation=cv2.INTER_AREA)

        shape_score = compute_shape_similarity(region, tpl_resized)
        interior_score = compute_interior_similarity(region, tpl_resized)
        tm = c["tm_confidence"]

        # Vector matching — only for candidates that already look promising
        vector_score = None
        if has_vector and tm >= 0.50:
            inv = 1.0 / page_scale
            cand_vector = extract_vector_data(
                pdf_path, page_num,
                x * inv, y * inv, w * inv, h * inv,
                drawings=page_drawings,
            )
            if cand_vector.get("segment_count", 0) > 0:
                vector_score = compare_vector_data(template_vector_data, cand_vector)

        # ORB feature matching — good for graphical symbols
        orb_score = None
        if tpl_type == "graphical":
            orb_score = compute_orb_similarity(region, tpl_resized)

        # Adaptive scoring: weight signals differently based on template type
        if tpl_type == "text-in-box":
            # Interior is critical — it distinguishes RS from KP
            if vector_score is not None:
                combined = (
                    interior_score * 0.40
                    + tm * 0.25
                    + shape_score * 0.20
                    + vector_score * 0.15
                )
            else:
                combined = (
                    interior_score * 0.45
                    + tm * 0.30
                    + shape_score * 0.25
                )
        else:
            # Graphical symbol — overall shape and template match matter most
            if orb_score is not None and vector_score is not None:
                combined = (
                    tm * 0.30
                    + shape_score * 0.25
                    + orb_score * 0.20
                    + interior_score * 0.10
                    + vector_score * 0.15
                )
            elif orb_score is not None:
                combined = (
                    tm * 0.35
                    + shape_score * 0.30
                    + orb_score * 0.20
                    + interior_score * 0.15
                )
            elif vector_score is not None:
                combined = (
                    tm * 0.35
                    + shape_score * 0.25
                    + interior_score * 0.15
                    + vector_score * 0.25
                )
            else:
                combined = (
                    tm * 0.40
                    + shape_score * 0.35
                    + interior_score * 0.25
                )

        # Text gate: if the template has embedded text (e.g. "RS"),
        # boost matches with the same text and heavily penalize mismatches.
        # This distinguishes symbols that look structurally identical but
        # have different labels (RS vs KP vs SEC etc).
        if template_inner_text and page_text_blocks is not None and page_scale:
            inv = 1.0 / page_scale
            cand_text = text_in_rect(
                page_text_blocks, x * inv, y * inv, w * inv, h * inv,
            )
            if cand_text:
                if _text_matches(template_inner_text, cand_text):
                    combined = min(combined * 1.15, 1.0)  # matching text — boost
                else:
                    combined *= 0.50  # wrong text — heavy penalty

        logger.debug(
            f"  candidate ({x},{y} {w}x{h}) [{tpl_type}]: tm={tm:.3f} shape={shape_score:.3f} "
            f"interior={interior_score:.3f} orb={orb_score} vector={vector_score} → combined={combined:.3f}"
        )

        if combined >= confidence_threshold:
            validated.append({
                "x_px": x,
                "y_px": y,
                "w_px": w,
                "h_px": h,
                "confidence": round(combined, 4),
                "scale": c["scale"],
                "rotation": c["rotation"],
            })

    # Final NMS pass
    final = non_maximum_suppression(validated, overlap_threshold=0.3)
    logger.info(
        f"Stage 2: {len(candidates)} candidates → {len(validated)} validated → {len(final)} final"
        f" (type={tpl_type}, vector={'yes' if has_vector else 'no'}"
        f", text_filter={'yes' if template_inner_text else 'no'})"
    )
    return final


def _text_matches(expected: str, found: str) -> bool:
    """Check if template text matches candidate text (case-insensitive)."""
    e = expected.strip().lower()
    f = found.strip().lower()
    return e == f or e in f or f in e


def compute_iou(a: dict, b: dict) -> float:
    x1 = max(a["x_px"], b["x_px"])
    y1 = max(a["y_px"], b["y_px"])
    x2 = min(a["x_px"] + a["w_px"], b["x_px"] + b["w_px"])
    y2 = min(a["y_px"] + a["h_px"], b["y_px"] + b["h_px"])

    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = a["w_px"] * a["h_px"]
    area_b = b["w_px"] * b["h_px"]
    union = area_a + area_b - intersection

    return intersection / union if union > 0 else 0


def non_maximum_suppression_candidates(
    matches: list[dict], overlap_threshold: float
) -> list[dict]:
    """NMS for candidates — keeps template_raw reference."""
    if not matches:
        return []
    matches = sorted(matches, key=lambda m: m["tm_confidence"], reverse=True)
    kept = []
    for match in matches:
        is_dup = False
        for k in kept:
            if compute_iou(match, k) > overlap_threshold:
                is_dup = True
                break
        if not is_dup:
            kept.append(match)
    return kept


def non_maximum_suppression(
    matches: list[dict], overlap_threshold: float
) -> list[dict]:
    if not matches:
        return []
    matches = sorted(matches, key=lambda m: m["confidence"], reverse=True)
    kept = []
    for match in matches:
        is_dup = False
        for k in kept:
            if compute_iou(match, k) > overlap_threshold:
                is_dup = True
                break
        if not is_dup:
            kept.append(match)
    return kept


def pixel_to_pdf_coords(match: dict, scale_factor: float) -> dict:
    inv = 1.0 / scale_factor
    return {
        "x": match["x_px"] * inv,
        "y": match["y_px"] * inv,
        "width": match["w_px"] * inv,
        "height": match["h_px"] * inv,
        "confidence": match["confidence"],
    }


def run_search(
    pdf_path: str,
    templates: list[dict],
    confidence_threshold: float,
    pages: list[int],
) -> dict:
    start_time = time.time()
    results = []
    total_matches = 0

    for page_num in pages:
        page_binary, page_gray, page_edges, page_scale = render_page(pdf_path, page_num)
        page_drawings = get_page_drawings(pdf_path, page_num)
        page_texts = get_page_text_blocks(pdf_path, page_num)

        for template_info in templates:
            template_raw = get_template(template_info["template_id"])
            template = rescale_template(template_raw, SCALE_FACTOR, page_scale)
            template_vector = load_vector_data(template_info["template_id"])
            tpl_inner_text = template_vector.get("inner_text") if template_vector else None

            logger.info(
                f"Matching '{template_info['symbol_name']}' "
                f"({template.shape[1]}x{template.shape[0]} px) "
                f"on page {page_num} ({page_binary.shape[1]}x{page_binary.shape[0]} px)"
                f"{f' [text: {tpl_inner_text}]' if tpl_inner_text else ''}"
            )

            pixel_matches = match_symbol_on_page(
                page_binary, page_gray, template, confidence_threshold,
                pdf_path=pdf_path,
                page_num=page_num,
                page_scale=page_scale,
                template_vector_data=template_vector,
                page_drawings=page_drawings,
                template_inner_text=tpl_inner_text,
                page_text_blocks=page_texts,
            )

            pdf_matches = []
            for match in pixel_matches:
                pdf_coords = pixel_to_pdf_coords(match, page_scale)
                pdf_coords["page"] = page_num
                pdf_matches.append(pdf_coords)

            existing = None
            for r in results:
                if r["template_id"] == template_info["template_id"]:
                    existing = r
                    break

            if existing:
                existing["matches"].extend(pdf_matches)
                existing["total_count"] += len(pdf_matches)
            else:
                results.append({
                    "template_id": template_info["template_id"],
                    "symbol_name": template_info["symbol_name"],
                    "matches": pdf_matches,
                    "total_count": len(pdf_matches),
                })

            total_matches += len(pdf_matches)
            logger.info(
                f"Found {len(pdf_matches)} matches for "
                f"'{template_info['symbol_name']}' on page {page_num}"
            )

    elapsed = time.time() - start_time
    logger.info(f"Search complete: {total_matches} total matches in {elapsed:.2f}s")
    return {
        "results": results,
        "total_matches": total_matches,
        "search_time_seconds": round(elapsed, 2),
    }


def clear_page_cache():
    _page_cache.clear()
    clear_drawings_cache()
    clear_text_cache()
