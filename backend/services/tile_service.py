"""Deep Zoom tile pyramids for sheets, built once at import time.

Each single-page sheet PDF is rasterised at TILE_SCALE x 72 DPI and cut into a DZI
pyramid with libvips (dzsave). Two variants: 'base' and, when the PDF has layers,
'nobg' (architectural xref layers hidden). The browser (OpenSeadragon) then only ever
fetches the tiles on screen, so pan/zoom cost no longer depends on sheet size.
"""
import json
import logging
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fitz

from services.pdf_service import DATA_DIR, get_pdf_path, nobg_pdf_path, NoLayersError

logger = logging.getLogger(__name__)

TILES_DIR = DATA_DIR / "tiles"
TILES_DIR.mkdir(parents=True, exist_ok=True)
TILE_SCALE = 6.0   # 6 x 72 = 432 DPI at the finest level
TILE_SIZE = 256

_pool = ThreadPoolExecutor(max_workers=2)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _vdir(pdf_id: str, variant: str) -> Path:
    return TILES_DIR / pdf_id / variant


def _ready(pdf_id: str, variant: str) -> bool:
    d = _vdir(pdf_id, variant)
    return (d / ".ready").exists() and (d / "image.dzi").exists()


def _whiten_background(pm) -> bytes:
    """Raster fallback for PDFs without layers: the architectural underlay is almost always
    drawn in grey, so light, unsaturated pixels become white. Pixels next to dark linework are
    left alone so the anti-aliased edges of the black electrical content don't get eaten."""
    import numpy as np
    import cv2

    arr = np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, pm.n).copy()
    rgb = arr[:, :, :3]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    grey = (mx - mn < 40) & (mn > 90) & (mx < 250)
    dark = (mn < 90).astype(np.uint8)
    near_dark = cv2.dilate(dark, np.ones((3, 3), np.uint8), iterations=1).astype(bool)
    arr[grey & ~near_dark] = 255
    return arr.tobytes()


def _build_variant(pdf_path: Path, out_dir: Path, on_progress, filter_bg: bool = False) -> dict:
    import pyvips  # loaded lazily so the API still boots if libvips is missing

    tmp = out_dir.parent / (out_dir.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)

    doc = fitz.open(str(pdf_path))
    page = doc[0]
    rect = page.rect
    t0 = time.time()
    pm = page.get_pixmap(matrix=fitz.Matrix(TILE_SCALE, TILE_SCALE), alpha=False)
    logger.info("rendered %s at %.0f DPI: %dx%d px in %.1fs", pdf_path.name, TILE_SCALE * 72, pm.width, pm.height, time.time() - t0)
    on_progress(20)

    buf = _whiten_background(pm) if filter_bg else pm.samples
    img = pyvips.Image.new_from_memory(buf, pm.width, pm.height, pm.n, "uchar")
    try:
        img.set_progress(True)
        img.signal_connect("eval", lambda _i, p: on_progress(20 + int(p.percent * 0.8)))
    except Exception:
        pass
    t1 = time.time()
    img.dzsave(str(tmp / "image"), tile_size=TILE_SIZE, overlap=0, suffix=".png", depth="onepixel")
    logger.info("tiled %s in %.1fs", pdf_path.name, time.time() - t1)

    meta = {"width_pt": rect.width, "height_pt": rect.height, "scale": TILE_SCALE, "width_px": pm.width, "height_px": pm.height}
    (tmp / "meta.json").write_text(json.dumps(meta))
    del img, pm, buf
    doc.close()
    (tmp / ".ready").touch()
    shutil.rmtree(out_dir, ignore_errors=True)
    tmp.rename(out_dir)
    return meta


def _run(pdf_id: str) -> None:
    job = _jobs[pdf_id]
    try:
        src = get_pdf_path(pdf_id)
        if not _ready(pdf_id, "base"):
            _build_variant(src, _vdir(pdf_id, "base"), lambda p: job.update(progress=int(p * 0.5)))
        job["progress"] = 50
        try:
            from services.vector_match import build_index
            build_index(pdf_id)
        except Exception:  # noqa: BLE001
            logger.exception("vector index failed for %s", pdf_id)
        nobg_dir = _vdir(pdf_id, "nobg")
        if not _ready(pdf_id, "nobg") and not (nobg_dir / ".none").exists():
            try:
                nb = nobg_pdf_path(pdf_id)  # layer-exact when the PDF has OCG layers
                _build_variant(nb, nobg_dir, lambda p: job.update(progress=50 + int(p * 0.5)))
            except NoLayersError:  # otherwise filter the grey underlay out of the raster
                _build_variant(src, nobg_dir, lambda p: job.update(progress=50 + int(p * 0.5)), filter_bg=True)
        job["progress"] = 100
    except Exception as e:  # noqa: BLE001
        logger.exception("tile job failed for %s", pdf_id)
        job["error"] = str(e)
    finally:
        job["done"] = True


def status(pdf_id: str) -> dict:
    base = _ready(pdf_id, "base")
    nobg_dir = _vdir(pdf_id, "nobg")
    nobg = False if (nobg_dir / ".none").exists() else (True if _ready(pdf_id, "nobg") else None)
    job = _jobs.get(pdf_id) or {}
    complete = base and nobg is not None
    meta = None
    if base:
        try:
            meta = json.loads((_vdir(pdf_id, "base") / "meta.json").read_text())
        except Exception:  # noqa: BLE001
            meta = None
    return {
        "ready": base,
        "nobg": nobg,
        "complete": complete,
        "running": bool(job) and not job.get("done", False),
        "progress": 100 if complete else int(job.get("progress", 0)),
        "error": job.get("error"),
        "meta": meta,
    }


def prepare(pdf_id: str) -> dict:
    """Start (or re-start after failure) the tile job for a sheet; idempotent."""
    get_pdf_path(pdf_id)  # FileNotFoundError if unknown
    with _lock:
        st = status(pdf_id)
        if st["complete"] or st["running"]:
            return st
        _jobs[pdf_id] = {"progress": 0, "done": False}
        _pool.submit(_run, pdf_id)
    return status(pdf_id)
