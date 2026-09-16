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


# ---------------------------------------------------------------------------
# Multi-page import support: sheet names, splitting, thumbnails
# ---------------------------------------------------------------------------
import re
from collections import Counter

# Drawing-number-ish tokens: 3025-EE-2025, E-101, A1-02, SK_04 ...
_DWG_RE = re.compile(r"\b[A-Z0-9]{1,6}(?:[-_][A-Z0-9]{1,6}){1,4}\b")
_SCALE_RE = re.compile(r"^\d+\s*[:/]\s*\d+$")
_DATE_RE = re.compile(r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4}")
_LABELS = {
    "SCALE", "DATE", "DRAWN", "CHECKED", "APPROVED", "DESIGNED", "REV", "REVISION", "SHEET",
    "DRAWING", "DRAWING NO", "DRAWING NO.", "DWG", "DWG NO", "DWG NO.", "PROJECT", "CLIENT",
    "TITLE", "STATUS", "ISSUE", "SIZE", "NOTES", "NORTH", "JOB NO", "JOB NO.", "JOB", "NO", "NO.",
    "A0", "A1", "A2", "A3", "A4", "OF", "PAGE", "DRAWING TITLE", "SHEET TITLE", "PROJECT TITLE",
}


def _spans(page) -> list[tuple[str, float, float, float, float, float]]:
    out = []
    for b in page.get_text("dict")["blocks"]:
        for line in b.get("lines", []):
            for s in line["spans"]:
                t = " ".join(s["text"].split())
                if len(t) < 2:
                    continue
                x0, y0, x1, y1 = s["bbox"]
                out.append((t, float(s["size"]), x0, y0, x1, y1))
    return out


def _is_noise(t: str) -> bool:
    u = t.upper().strip(" :")
    return (
        u in _LABELS
        or _SCALE_RE.match(u) is not None
        or _DATE_RE.search(u) is not None
        or u.replace(".", "").replace("/", "").replace("-", "").isdigit()
    )


def page_names(pdf_id: str) -> list[dict]:
    """Best-effort sheet name per page: '<drawing no> - <title>' from the title block."""
    doc = fitz.open(str(get_pdf_path(pdf_id)))
    n = doc.page_count
    per_page = [_spans(doc[i]) for i in range(n)]

    # Text present on most pages is boilerplate (company, project name, address) — not a sheet title.
    freq = Counter()
    for spans in per_page:
        for t in {s[0].upper() for s in spans}:
            freq[t] += 1
    boiler = {t for t, c in freq.items() if n >= 3 and c > n * 0.5}

    names = []
    for i in range(n):
        page = doc[i]
        r = page.rect
        spans = [s for s in per_page[i] if s[0].upper() not in boiler and not _is_noise(s[0])]

        def in_title_block(s):
            cx, cy = (s[2] + s[4]) / 2, (s[3] + s[5]) / 2
            return cx > r.x0 + r.width * 0.72 or cy > r.y0 + r.height * 0.78

        tb = [s for s in spans if in_title_block(s)] or spans
        dwg = None
        for t, *_ in sorted(tb, key=lambda s: -s[1]):
            m = _DWG_RE.search(t.upper())
            if m and any(c.isdigit() for c in m.group()) and ("-" in m.group() or "_" in m.group()):
                dwg = m.group()
                break

        cands = [s for s in tb if not (dwg and dwg in s[0].upper())] or tb
        title = ""
        if cands:
            mx = max(s[1] for s in cands)
            picked = sorted([s for s in cands if s[1] >= mx * 0.85], key=lambda s: (round(s[3]), s[2]))
            title = " ".join(s[0] for s in picked).strip()[:120]

        if dwg and title:
            name = f"{dwg} - {title}"
        else:
            name = title or dwg or f"Page {i + 1}"
        names.append({"page": i + 1, "name": name})
    doc.close()
    return names


def split_pdf(pdf_id: str, pages: list[int]) -> list[dict]:
    """Write each selected page out as its own single-page PDF."""
    src_path = get_pdf_path(pdf_id)
    names = {p["page"]: p["name"] for p in page_names(pdf_id)}
    src = fitz.open(str(src_path))
    out = []
    for p in pages:
        if p < 1 or p > src.page_count:
            continue
        new_id = str(uuid.uuid4())[:8]
        new = fitz.open()
        new.insert_pdf(src, from_page=p - 1, to_page=p - 1)
        new.save(str(PDF_DIR / f"{new_id}.pdf"))
        new.close()
        rect = src[p - 1].rect
        out.append({
            "page": p,
            "pdf_id": new_id,
            "filename": names.get(p, f"Page {p}"),
            "page_count": 1,
            "page_sizes": [{"page": 1, "width_pts": round(rect.width, 1), "height_pts": round(rect.height, 1)}],
        })
    src.close()
    return out


def thumbnail_path(pdf_id: str, width_px: int = 600) -> Path:
    """PNG of page 1, rendered once and cached beside the PDF."""
    thumb = PDF_DIR / f"{pdf_id}.thumb.png"
    if thumb.exists():
        return thumb
    doc = fitz.open(str(get_pdf_path(pdf_id)))
    page = doc[0]
    z = width_px / max(page.rect.width, 1)
    page.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False).save(str(thumb))
    doc.close()
    return thumb


# ---------------------------------------------------------------------------
# Hide Background: copy of the PDF with the architectural xref layers switched off
# ---------------------------------------------------------------------------
class NoLayersError(Exception):
    """The PDF has no optional-content layers we can switch off."""


# AutoCAD bound-xref layers come through as '<xref>|<layer>' (e.g. 'x-Site|BLDG-EXTERNAL'),
# usually with an 'x-' prefix; a bare 'XREF' layer is the xref insert itself.
_BG_LAYER_RE = re.compile(r"^(x-|xref)|\||grid", re.I)


def nobg_pdf_path(pdf_id: str) -> Path:
    out = PDF_DIR / f"{pdf_id}.nobg.pdf"
    if out.exists():
        return out
    doc = fitz.open(str(get_pdf_path(pdf_id)))
    try:
        ocgs = doc.get_ocgs()  # xref -> {name, on, ...}
        if not ocgs:
            raise NoLayersError()
        off = [x for x, v in ocgs.items() if _BG_LAYER_RE.search(v.get("name", ""))]
        if not off:
            raise NoLayersError()
        # Edit the default OC config (/OCProperties /D) so the hidden state is saved in the file
        # and honoured by any viewer, pdf.js included.
        doc.set_layer(-1, off=off)
        doc.save(str(out))
    finally:
        doc.close()
    return out


# ---------------------------------------------------------------------------
# Clip rendering: rasterise a small region of a sheet at display resolution (for match tinting)
# ---------------------------------------------------------------------------
import threading as _threading
from collections import OrderedDict as _OrderedDict

_dl_lock = _threading.Lock()
_dl_cache: "_OrderedDict[str, tuple]" = _OrderedDict()  # pdf_id -> (doc, displaylist)
_DL_MAX = 8


def _display_list(pdf_id: str):
    """Cached MuPDF display list for page 1 so clip renders don't re-interpret the whole page."""
    ent = _dl_cache.get(pdf_id)
    if ent is None:
        doc = fitz.open(str(get_pdf_path(pdf_id)))
        ent = (doc, doc[0].get_displaylist())
        _dl_cache[pdf_id] = ent
        while len(_dl_cache) > _DL_MAX:
            _, (old_doc, _dl) = _dl_cache.popitem(last=False)
            old_doc.close()
    else:
        _dl_cache.move_to_end(pdf_id)
    return ent[1]


def render_clip(pdf_id: str, x: float, y: float, w: float, h: float, z: float, pad: float) -> bytes:
    """PNG of the rect [x,y,w,h] (pt, padded by `pad` pt) rendered at `z` px per pt."""
    z = max(1.0, min(48.0, z))
    rect = fitz.Rect(x - pad, y - pad, x + w + pad, y + h + pad)
    if rect.width * z * rect.height * z > 6_000_000:
        raise ValueError("clip too large")
    with _dl_lock:
        dl = _display_list(pdf_id)
        pm = dl.get_pixmap(matrix=fitz.Matrix(z, z), clip=rect, alpha=False)
        return pm.tobytes("png")
