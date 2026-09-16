"""Geometry (vector) matching of CAD symbols.

Symbols on CAD-plotted PDFs are inserted blocks, so every instance has identical geometry.
We read the sheet's own vector paths (PyMuPDF get_drawings), take the primitives inside the
user's box as the template, and find every position/rotation/mirror on the sheet where that
same set of segments recurs. Exact, resolution-independent, and immune to look-alikes with
different geometry. Text inside the box (KP, ML ...) must match too.
"""
import json
import logging
import math
import os
import time
from collections import OrderedDict
from pathlib import Path

import fitz
import numpy as np

from services.pdf_service import get_pdf_path

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/pdf-symbol-search"))
VEC_DIR = DATA_DIR / "vec"
VEC_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATE_DIR = DATA_DIR / "templates"

MAX_SEG_LEN = 150.0   # pt - longer primitives are walls/wires, never part of a symbol
MIN_SEG_LEN = 0.05
CURVE_CHORDS = 4
TOL = 0.35            # pt endpoint tolerance
CELL = 2.0            # spatial hash cell size (pt)
MIN_TEMPLATE_SEGS = 3
MAX_HYPOTHESES = 60000

_cache: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_MAX = 6


# ---------------------------------------------------------------- indexing

def _flatten(items) -> list[tuple[float, float, float, float]]:
    segs = []
    for it in items:
        k = it[0]
        if k == "l":
            p, q = it[1], it[2]
            segs.append((p.x, p.y, q.x, q.y))
        elif k == "c":
            p0, p1, p2, p3 = it[1], it[2], it[3], it[4]
            px, py = p0.x, p0.y
            for i in range(1, CURVE_CHORDS + 1):
                t = i / CURVE_CHORDS
                mt = 1 - t
                x = mt ** 3 * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * p3.x
                y = mt ** 3 * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * p3.y
                segs.append((px, py, x, y))
                px, py = x, y
        elif k == "re":
            r = it[1]
            segs += [(r.x0, r.y0, r.x1, r.y0), (r.x1, r.y0, r.x1, r.y1), (r.x1, r.y1, r.x0, r.y1), (r.x0, r.y1, r.x0, r.y0)]
        elif k == "qu":
            q = it[1]
            pts = [q.ul, q.ur, q.lr, q.ll]
            for i in range(4):
                a, b = pts[i], pts[(i + 1) % 4]
                segs.append((a.x, a.y, b.x, b.y))
    return segs


def index_path(pdf_id: str) -> Path:
    return VEC_DIR / f"{pdf_id}.npz"


def build_index(pdf_id: str) -> None:
    """Extract all segments + words of page 1 and save them (idempotent)."""
    path = index_path(pdf_id)
    if path.exists():
        return
    t0 = time.time()
    doc = fitz.open(str(get_pdf_path(pdf_id)))
    page = doc[0]
    segs: list = []
    for d in page.get_drawings():
        segs.extend(_flatten(d.get("items", [])))
    arr = np.asarray(segs, dtype=np.float32).reshape(-1, 4)
    ln = np.hypot(arr[:, 2] - arr[:, 0], arr[:, 3] - arr[:, 1])
    arr = arr[(ln >= MIN_SEG_LEN) & (ln <= MAX_SEG_LEN)]
    words = [[w[0], w[1], w[2], w[3], w[4]] for w in page.get_text("words")]
    doc.close()
    tmp = path.with_suffix(".tmp.npz")
    np.savez(tmp, seg=arr)
    tmp.rename(path)
    (VEC_DIR / f"{pdf_id}.words.json").write_text(json.dumps(words))
    logger.info("vector index %s: %d segments, %d words in %.1fs", pdf_id, len(arr), len(words), time.time() - t0)


def load_index(pdf_id: str) -> dict:
    ent = _cache.get(pdf_id)
    if ent:
        _cache.move_to_end(pdf_id)
        return ent
    build_index(pdf_id)
    seg = np.load(index_path(pdf_id))["seg"]
    wp = VEC_DIR / f"{pdf_id}.words.json"
    words = json.loads(wp.read_text()) if wp.exists() else []
    mid = (seg[:, :2] + seg[:, 2:]) / 2
    ln = np.hypot(seg[:, 2] - seg[:, 0], seg[:, 3] - seg[:, 1])
    cells: dict[tuple[int, int], list[int]] = {}
    cx = np.floor(mid[:, 0] / CELL).astype(np.int64)
    cy = np.floor(mid[:, 1] / CELL).astype(np.int64)
    for i in range(len(seg)):
        cells.setdefault((int(cx[i]), int(cy[i])), []).append(i)
    ent = {"seg": seg, "mid": mid, "len": ln, "cells": cells, "words": words}
    _cache[pdf_id] = ent
    while len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)
    return ent


# ------------------------------------------------------- template geometry

def template_geometry(pdf_id: str, x: float, y: float, w: float, h: float) -> dict:
    """Primitives fully inside the box (wires entering the box are excluded) + inner words."""
    idx = load_index(pdf_id)
    seg = idx["seg"]
    m = 0.25
    inside = ((np.minimum(seg[:, 0], seg[:, 2]) >= x - m) & (np.maximum(seg[:, 0], seg[:, 2]) <= x + w + m)
              & (np.minimum(seg[:, 1], seg[:, 3]) >= y - m) & (np.maximum(seg[:, 1], seg[:, 3]) <= y + h + m))
    t = seg[inside]
    words = sorted(str(wd[4]).lower() for wd in idx["words"] if wd[0] >= x - m and wd[2] <= x + w + m and wd[1] >= y - m and wd[3] <= y + h + m)
    return {"pdf_id": pdf_id, "box": [x, y, w, h], "seg": t.tolist(), "words": words}


def save_geometry(template_id: str, geom: dict) -> None:
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    (TEMPLATE_DIR / f"{template_id}_geom.json").write_text(json.dumps(geom))


def load_geometry(template_id: str) -> dict | None:
    p = TEMPLATE_DIR / f"{template_id}_geom.json"
    return json.loads(p.read_text()) if p.exists() else None


# ------------------------------------------------------------------ search

def _has_segment(idx: dict, ax: float, ay: float, bx: float, by: float) -> bool:
    mx, my = (ax + bx) / 2, (ay + by) / 2
    cx, cy = int(math.floor(mx / CELL)), int(math.floor(my / CELL))
    seg, cells = idx["seg"], idx["cells"]
    t2 = TOL * TOL
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for i in cells.get((cx + dx, cy + dy), ()):
                s = seg[i]
                if ((s[0] - ax) ** 2 + (s[1] - ay) ** 2 <= t2 and (s[2] - bx) ** 2 + (s[3] - by) ** 2 <= t2) or \
                   ((s[0] - bx) ** 2 + (s[1] - by) ** 2 <= t2 and (s[2] - ax) ** 2 + (s[3] - ay) ** 2 <= t2):
                    return True
    return False


def _hypotheses(idx: dict, T: np.ndarray, min_score: float, n_anchors: int = 3, window=None):
    """Test every placement suggested by up to n_anchors template segments.
    Returns (hits, per-hit matched mask over T) - hits as (score, x0, y0, x1, y1)."""
    S, Slen = idx["seg"], idx["len"]
    Tlen = np.hypot(T[:, 2] - T[:, 0], T[:, 3] - T[:, 1])
    total_len = float(Tlen.sum())
    if total_len <= 0:
        return [], []

    # anchors: template segments whose length is rarest on the sheet (fewest placements to test)
    scored = []
    for i in range(len(T)):
        if Tlen[i] < 0.8:
            continue
        scored.append((int(np.count_nonzero(np.abs(Slen - Tlen[i]) <= 2 * TOL)), -Tlen[i], i))
    if not scored:
        scored = [(0, -Tlen.max(), int(np.argmax(Tlen)))]
    scored.sort()
    anchors = [i for _, _, i in scored[:n_anchors]]

    order = np.argsort(-Tlen)
    Lo_len = Tlen[order]
    cum_rest = np.concatenate([np.cumsum(Lo_len[::-1])[::-1][1:], [0.0]])

    hits, masks, worlds = [], [], []
    budget = MAX_HYPOTHESES
    for ai in anchors:
        a = T[ai]
        amid = np.array([(a[0] + a[2]) / 2, (a[1] + a[3]) / 2])
        aang = math.atan2(a[3] - a[1], a[2] - a[0])
        c, s_ = math.cos(-aang), math.sin(-aang)
        R = np.array([[c, -s_], [s_, c]])
        L = ((T.reshape(-1, 2) - amid) @ R.T).reshape(-1, 4)
        Lo, Lmo = L[order], (L * np.array([1, -1, 1, -1]))[order]
        cands = np.where(np.abs(Slen - Tlen[ai]) <= 2 * TOL)[0]
        if window is not None:
            mid = idx["mid"][cands]
            cands = cands[(mid[:, 0] >= window[0]) & (mid[:, 0] <= window[2]) & (mid[:, 1] >= window[1]) & (mid[:, 1] <= window[3])]
        if len(cands) * 4 > budget:
            cands = cands[: max(1, budget // 4)]
        budget -= len(cands) * 4
        for ci in cands:
            sg = S[ci]
            smid = np.array([(sg[0] + sg[2]) / 2, (sg[1] + sg[3]) / 2], dtype=np.float64)
            sang = math.atan2(sg[3] - sg[1], sg[2] - sg[0])
            for flip in (0.0, math.pi):
                th = sang + flip
                cc, ss = math.cos(th), math.sin(th)
                Rr = np.array([[cc, -ss], [ss, cc]])
                for Lsrc in (Lo, Lmo):
                    W = (Lsrc.reshape(-1, 2) @ Rr.T + smid).reshape(-1, 4)
                    matched = 0.0
                    mask = np.zeros(len(W), dtype=bool)
                    ok = True
                    for k in range(len(W)):
                        if _has_segment(idx, W[k, 0], W[k, 1], W[k, 2], W[k, 3]):
                            matched += Lo_len[k]
                            mask[k] = True
                        elif (matched + cum_rest[k]) / total_len < min_score:
                            ok = False
                            break
                    if not ok:
                        continue
                    score = matched / total_len
                    if score >= min_score:
                        xs = np.concatenate([W[:, 0], W[:, 2]]); ys = np.concatenate([W[:, 1], W[:, 3]])
                        hits.append((score, float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())))
                        m_orig = np.zeros(len(T), dtype=bool); m_orig[order] = mask
                        masks.append(m_orig)
                        W_orig = np.zeros_like(W); W_orig[order] = W
                        worlds.append(W_orig)
        if budget <= 0:
            break
    return hits, masks, worlds


def _dedupe(hits, masks=None, worlds=None):
    idxs = sorted(range(len(hits)), key=lambda i: -hits[i][0])
    kept, kept_masks, kept_worlds = [], [], []
    for i in idxs:
        h = hits[i]
        cx, cy = (h[1] + h[3]) / 2, (h[2] + h[4]) / 2
        tolc = 0.5 * max(1.0, min(h[3] - h[1], h[4] - h[2]))
        if all(abs(cx - (k[1] + k[3]) / 2) > tolc or abs(cy - (k[2] + k[4]) / 2) > tolc for k in kept):
            kept.append(h)
            if masks is not None:
                kept_masks.append(masks[i])
            if worlds is not None:
                kept_worlds.append(worlds[i])
    return kept, kept_masks, kept_worlds


def _ink_inside(idx: dict, x0: float, y0: float, x1: float, y1: float) -> float:
    """Total length of sheet segments lying fully inside the box (crossing wires excluded)."""
    seg, cells = idx["seg"], idx["cells"]
    total = 0.0
    for cx in range(int(math.floor(x0 / CELL)) - 1, int(math.floor(x1 / CELL)) + 2):
        for cy in range(int(math.floor(y0 / CELL)) - 1, int(math.floor(y1 / CELL)) + 2):
            for i in cells.get((cx, cy), ()):
                sg = seg[i]
                if min(sg[0], sg[2]) >= x0 and max(sg[0], sg[2]) <= x1 and min(sg[1], sg[3]) >= y0 and max(sg[1], sg[3]) <= y1:
                    total += math.hypot(sg[2] - sg[0], sg[3] - sg[1])
    return total


def _touches_outside(idx: dict, seg_rows: np.ndarray, box) -> np.ndarray:
    """For each segment: does it connect (within TOL) to sheet geometry that leaves the box?
    Wire stubs do; text labels and detached glyphs don't."""
    x0, y0, x1, y1 = box
    S, cells = idx["seg"], idx["cells"]
    out = np.zeros(len(seg_rows), dtype=bool)
    t2 = TOL * TOL
    for k, sg in enumerate(seg_rows):
        for (px, py) in ((sg[0], sg[1]), (sg[2], sg[3])):
            cx, cy = int(math.floor(px / CELL)), int(math.floor(py / CELL))
            hit = False
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for i in cells.get((cx + dx, cy + dy), ()):
                        o = S[i]
                        if ((o[0] - px) ** 2 + (o[1] - py) ** 2 <= t2) or ((o[2] - px) ** 2 + (o[3] - py) ** 2 <= t2):
                            if min(o[0], o[2]) < x0 - 0.5 or max(o[0], o[2]) > x1 + 0.5 or min(o[1], o[3]) < y0 - 0.5 or max(o[1], o[3]) > y1 + 0.5:
                                hit = True
                    if hit: break
                if hit: break
            if hit:
                out[k] = True
                break
    return out


def _attr_score(idx: dict, A: np.ndarray, box) -> float:
    """Best match of an attribute component anywhere near a candidate box (any offset/rotation)."""
    x0, y0, x1, y1 = box
    pad = 0.6 * max(x1 - x0, y1 - y0) + 1.5
    h, _, _ = _hypotheses(idx, A, 0.5, n_anchors=2, window=(x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    return max((hh[0] for hh in h), default=0.0)


def _components(P: np.ndarray) -> list[np.ndarray]:
    """Split segments into connected components (endpoints touching within TOL)."""
    n = len(P)
    parent = list(range(n))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    pts = P.reshape(-1, 2)  # 2n points, point j belongs to segment j//2
    t2 = TOL * TOL
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = pts[i] - pts[j]
            if d[0] * d[0] + d[1] * d[1] <= t2:
                a, b = find(i // 2), find(j // 2)
                if a != b: parent[a] = b
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return [P[g] for g in groups.values()]


LAST_DEBUG: dict = {}


def find_instances(pdf_id: str, geom: dict, min_score: float = 0.9, max_extra: float | None = None) -> list[dict]:
    """All occurrences of the boxed symbol on the sheet.

    CAD model: a symbol is a block (geometry that recurs at a fixed offset) plus attributes
    (labels placed per instance at varying offsets). A permissive pass over the raw box finds
    candidate instances; segments recurring across them are the block. Leftover segments that
    form connected glyph-like components AND recur near other instances are attributes (each
    must be found near every match, at any offset); everything else (wire stubs, dashes) is
    clutter and dropped."""
    t0 = time.time()
    T = np.asarray(geom.get("seg", []), dtype=np.float64).reshape(-1, 4)
    if len(T) < MIN_TEMPLATE_SEGS:
        return []
    idx = load_index(pdf_id)

    # Permissive pass to discover sibling instances. A cluttered box needs a lower bar, but a
    # block learned from low-scoring hits must still explain at least half the boxed geometry,
    # or we would learn a generic fragment (a bare square matches everything). If no lower
    # threshold passes that test, fall back to the honest 0.6 result.
    Tlen_all = np.hypot(T[:, 2] - T[:, 0], T[:, 3] - T[:, 1])
    fallback = None
    for th in (0.6, 0.45, 0.35):
        hits, masks, worlds = _hypotheses(idx, T, th)
        hits, masks, worlds = _dedupe(hits, masks, worlds)
        if fallback is None:
            fallback = (hits, masks, worlds)
        if len(hits) >= 3:
            if th < 0.6:
                support = np.mean(np.stack(masks), axis=0)
                if float(Tlen_all[support >= 0.5].sum()) / max(float(Tlen_all.sum()), 1e-9) < 0.5:
                    hits = []  # fragment; keep looking, else fall back
                    continue
            break
    if len(hits) < 3 and fallback is not None:
        hits, masks, worlds = fallback
    core, attrs = T, []
    n_clutter = 0
    if len(hits) >= 2:
        support = np.mean(np.stack(masks), axis=0)
        keep = support >= 0.5
        if keep.sum() >= MIN_TEMPLATE_SEGS and keep.sum() < len(T):
            core = T[keep]
            comps = [c for c in _components(T[~keep]) if len(c) >= 2 and float(np.hypot(c[:, 2] - c[:, 0], c[:, 3] - c[:, 1]).sum()) >= 1.0]
            learn_hits = hits[:40]
            # A learning instance polluted with unexplained ink may be a *superset* symbol
            # (a double where the user boxed a single) - an attribute missing there is evidence
            # FOR the attribute, not against it. Judge reliability on clean instances only.
            tlen_all = float(np.hypot(T[:, 2] - T[:, 0], T[:, 3] - T[:, 1]).sum())
            clean_hits = [h for h in learn_hits
                          if (_ink_inside(idx, h[1] - 1.0, h[2] - 1.0, h[3] + 1.0, h[4] + 1.0) - h[0] * tlen_all) / tlen_all <= 0.15]
            if not clean_hits:
                clean_hits = learn_hits
            for c in comps:
                need = 0.9 if len(c) < 4 else 0.6
                near = sum(1 for h in clean_hits if _attr_score(idx, c, (h[1], h[2], h[3], h[4])) >= need)
                # real attributes hold at essentially every clean instance; leader lines and
                # wire dashes recur at many-but-not-all and must stay clutter
                if near >= min(2, len(clean_hits)) and near >= 0.85 * len(clean_hits):
                    attrs.append(c)
            n_clutter = int((~keep).sum()) - sum(len(a) for a in attrs)
            logger.info("template: block %d segs, %d attributes (%d segs), %d clutter segs (from %d hits)",
                        len(core), len(attrs), sum(len(a) for a in attrs), n_clutter, len(hits))

    if core is not T or not hits:
        hits, masks, worlds = _hypotheses(idx, core, min_score)
        hits, masks, worlds = _dedupe(hits, masks, worlds)
    else:
        keep_i = [i for i, h in enumerate(hits) if h[0] >= min_score]
        hits, masks, worlds = [hits[i] for i in keep_i], [masks[i] for i in keep_i], [worlds[i] for i in keep_i]
    clen = np.hypot(core[:, 2] - core[:, 0], core[:, 3] - core[:, 1])
    core_len = float(clen.sum())
    attr_len = float(sum(np.hypot(a[:, 2] - a[:, 0], a[:, 3] - a[:, 1]).sum() for a in attrs))

    twords = geom.get("words") or []

    def attr_gate(box) -> float:
        # tiny components (few segments) match too easily; hold them to a near-perfect score
        worst = 1.0
        for a in attrs:
            need = 0.9 if len(a) < 4 else 0.6
            got = _attr_score(idx, a, box)
            worst = min(worst, got / need if need > 0 else 1.0)
            if worst < 1.0 and got < need:
                return got / need
        return worst

    def extra_at(x0, y0, x1, y1, matched_len):
        return (_ink_inside(idx, x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0) - matched_len) / max(core_len + attr_len, 1e-6)

    # Calibrate the unexplained-ink gate on the instance the user actually boxed: that is what
    # "normal context" looks like (crossing wires vary, so keep slack).
    ucx, ucy = geom["box"][0] + geom["box"][2] / 2, geom["box"][1] + geom["box"][3] / 2
    base_extra = None
    for (sc, x0, y0, x1, y1), mk in zip(hits, masks):
        if x0 - 2 <= ucx <= x1 + 2 and y0 - 2 <= ucy <= y1 + 2:
            base_extra = extra_at(x0, y0, x1, y1, float(clen[mk].sum()) + attr_len)
            break
    # subset symbols are rejected by attributes now; extra ink is only a backstop
    eff_extra = max_extra if max_extra is not None else (1.0 if base_extra is None else max(1.0, base_extra + 0.3))

    def interior_miss(mk, W, x0, y0, x1, y1) -> float:
        """Unmatched core length sitting well inside the matched box - a true CAD block only
        loses segments at the box edge (clipped wires), never in its middle (wrong code letters)."""
        if mk.all():
            return 0.0
        inset = min(2.0, 0.2 * min(x1 - x0, y1 - y0))
        miss = 0.0
        for k in np.where(~mk)[0]:
            mx, my = (W[k, 0] + W[k, 2]) / 2, (W[k, 1] + W[k, 3]) / 2
            if x0 + inset <= mx <= x1 - inset and y0 + inset <= my <= y1 - inset:
                miss += clen[k]
        return miss / max(core_len, 1e-6)

    out = []
    dbg = {"n_core": len(core), "n_attr": sum(len(a) for a in attrs), "n_tpl": len(T), "base_extra": base_extra, "eff_extra": round(eff_extra, 2), "cands": []}
    for (sc, x0, y0, x1, y1), mk, W in zip(hits, masks, worlds):
        a_sc = attr_gate((x0, y0, x1, y1))
        matched_len = float(clen[mk].sum()) + attr_len * min(1.0, a_sc)
        extra = extra_at(x0, y0, x1, y1, matched_len)
        imiss = interior_miss(mk, W, x0, y0, x1, y1)
        words_ok = True
        if twords:
            ws = sorted(str(wd[4]).lower() for wd in idx["words"] if wd[0] >= x0 - 1 and wd[2] <= x1 + 1 and wd[1] >= y0 - 1 and wd[3] <= y1 + 1)
            words_ok = ws == twords
        gate = "ok" if (a_sc >= 1.0 and extra <= eff_extra and imiss <= 0.04 and words_ok) else ("attr" if a_sc < 1.0 else ("imiss" if imiss > 0.04 else ("extra" if extra > eff_extra else "words")))
        dbg["cands"].append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "core": round(sc, 2), "attr": round(a_sc, 2), "extra": round(extra, 2), "imiss": round(imiss, 2), "gate": gate})
        if gate != "ok":
            continue
        out.append({"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0, "confidence": round(min(sc, min(1.0, a_sc)), 3)})
    LAST_DEBUG.clear(); LAST_DEBUG.update(dbg)
    logger.info("vector search %s: %d segs (block %d, attrs %d) -> %d matches in %.2fs",
                pdf_id, len(T), len(core), len(attrs), len(out), time.time() - t0)
    return out


def merge_matches(vector: list[dict], raster: list[dict], raster_min_conf: float = 0.9) -> list[dict]:
    """Vector results win; raster hits survive only if confident and not already covered."""
    if not vector:
        return raster
    out = list(vector)
    for r in raster:
        if r.get("confidence", 0) < raster_min_conf:
            continue
        rcx, rcy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
        covered = any(v["x"] - 1 <= rcx <= v["x"] + v["width"] + 1 and v["y"] - 1 <= rcy <= v["y"] + v["height"] + 1 for v in vector)
        if not covered:
            out.append(r)
    return out
