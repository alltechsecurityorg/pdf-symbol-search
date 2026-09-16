import json
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from fastapi import FastAPI, UploadFile, File, HTTPException

logging.basicConfig(level=logging.INFO)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from sse_starlette.sse import EventSourceResponse
import io

from models.schemas import (
    CropRequest,
    CropResponse,
    SearchRequest,
    SearchResponse,
    ExportRequest,
    UploadResponse,
    AnnotateRequest,
    AiCountRequest,
    PageInfo,
    SplitRequest,
    SplitItem,
)
from services.pdf_service import save_pdf, get_pdf_path, page_names, split_pdf, thumbnail_path, nobg_pdf_path, NoLayersError, render_clip
from fastapi.responses import Response
from services.crop_service import crop_symbol
from services.search_service import run_search, render_page, rescale_template, get_template, match_symbol_on_page, pixel_to_pdf_coords, clear_page_cache
from services.vector_service import load_vector_data, get_page_drawings
from services.text_service import get_page_text_blocks
from services.export_service import export_csv
from services.tile_service import prepare as prepare_tiles, status as tiles_status, TILES_DIR
from services.vector_match import load_geometry, find_instances, merge_matches
from services.ai_service import run_ai_count
from starlette.concurrency import iterate_in_threadpool
from fastapi.staticfiles import StaticFiles
from utils.coordinates import SCALE_FACTOR

app = FastAPI(title="PDF Symbol Search")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Thread pool for CPU-intensive operations (PDF rendering, template matching)
_executor = ThreadPoolExecutor(max_workers=4)


async def run_in_thread(fn, *args, **kwargs):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, partial(fn, *args, **kwargs))


@app.post("/api/upload-pdf", response_model=UploadResponse)
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="File must be a PDF")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        result = await run_in_thread(save_pdf, content, file.filename)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {str(e)}")

    if result["page_count"] == 1:
        prepare_tiles(result["pdf_id"])
    return result


@app.get("/api/pdf/{pdf_id}")
async def serve_pdf(pdf_id: str):
    try:
        filepath = get_pdf_path(pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")

    return FileResponse(
        str(filepath),
        media_type="application/pdf",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
        },
    )


@app.post("/api/crop-symbol", response_model=CropResponse)
async def crop_symbol_endpoint(request: CropRequest):
    try:
        pdf_path = get_pdf_path(request.pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")

    try:
        result = await run_in_thread(
            crop_symbol,
            str(pdf_path),
            request.page,
            request.x,
            request.y,
            request.width,
            request.height,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Crop failed: {str(e)}")

    return result


@app.post("/api/run-search", response_model=SearchResponse)
async def run_search_endpoint(request: SearchRequest):
    try:
        pdf_path = get_pdf_path(request.pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")

    import fitz
    doc = fitz.open(str(pdf_path))
    page_count = doc.page_count
    doc.close()

    pages = request.pages or list(range(1, page_count + 1))

    templates = [
        {"template_id": s.template_id, "symbol_name": s.symbol_name}
        for s in request.symbols
    ]

    try:
        result = await run_in_thread(
            run_search,
            str(pdf_path), templates, request.confidence_threshold, pages
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

    return result


@app.post("/api/run-search-stream")
async def run_search_stream(request: SearchRequest):
    try:
        pdf_path = get_pdf_path(request.pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")

    import fitz
    doc = fitz.open(str(pdf_path))
    page_count = doc.page_count
    doc.close()

    pages = request.pages or list(range(1, page_count + 1))

    async def event_generator():
        total_symbols = len(request.symbols)

        for page_num in pages:
            page_binary, page_gray, _, page_scale = await run_in_thread(render_page, str(pdf_path), page_num)
            page_dwg = await run_in_thread(get_page_drawings, str(pdf_path), page_num)
            page_texts = await run_in_thread(get_page_text_blocks, str(pdf_path), page_num)

            for i, symbol in enumerate(request.symbols):
                yield {
                    "event": "progress",
                    "data": json.dumps({
                        "current": i + 1,
                        "total": total_symbols,
                        "symbol_name": symbol.symbol_name,
                        "page": page_num,
                    }),
                }

                template_raw = get_template(symbol.template_id)
                template = rescale_template(template_raw, SCALE_FACTOR, page_scale)
                template_vector = load_vector_data(symbol.template_id)
                tpl_inner_text = template_vector.get("inner_text") if template_vector else None
                pixel_matches = await run_in_thread(
                    match_symbol_on_page,
                    page_binary, page_gray, template, request.confidence_threshold,
                    None, None,  # scales, rotations (use defaults)
                    str(pdf_path), page_num, page_scale,
                    template_vector, page_dwg,
                    tpl_inner_text, page_texts,
                )

                pdf_matches = []
                for match in pixel_matches:
                    pdf_coords = pixel_to_pdf_coords(match, page_scale)
                    pdf_coords["page"] = page_num
                    pdf_matches.append(pdf_coords)

                # Geometry matching on the sheet's own vectors (exact for CAD blocks); raster fills gaps.
                geom = load_geometry(symbol.template_id)
                if geom and page_num == 1:
                    try:
                        vec = await run_in_thread(find_instances, request.pdf_id, geom)
                    except Exception:  # noqa: BLE001
                        logging.getLogger(__name__).exception("vector search failed")
                        vec = []
                    for v in vec:
                        v["page"] = page_num
                    if vec:
                        pdf_matches = merge_matches(vec, pdf_matches)

                yield {
                    "event": "symbol_complete",
                    "data": json.dumps({
                        "template_id": symbol.template_id,
                        "symbol_name": symbol.symbol_name,
                        "matches": pdf_matches,
                        "total_count": len(pdf_matches),
                        "page": page_num,
                    }),
                }

        yield {"event": "done", "data": ""}

    return EventSourceResponse(event_generator())


@app.post("/api/export-results")
async def export_results(request: ExportRequest):
    if request.format == "csv":
        results_dicts = [r.model_dump() for r in request.results]
        csv_content = export_csv(results_dicts)
        return StreamingResponse(
            io.BytesIO(csv_content.encode()),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=symbol_results.csv"},
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {request.format}")


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert '#rrggbb' to (r, g, b) in 0-1 range."""
    hex_color = hex_color.lstrip("#")
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)


def _annotate_pdf(pdf_path: str, symbols: list[dict]) -> bytes:
    import fitz

    doc = fitz.open(pdf_path)

    for symbol in symbols:
        color = _hex_to_rgb(symbol["color"])
        fill_color = color
        name = symbol["name"]

        for match in symbol["matches"]:
            page_num = match["page"]
            if page_num < 1 or page_num > doc.page_count:
                continue

            page = doc[page_num - 1]

            # Match coords are in PDF points (72 DPI)
            rect = fitz.Rect(
                match["x"],
                match["y"],
                match["x"] + match["width"],
                match["y"] + match["height"],
            )

            # Draw filled rectangle with transparency
            shape = page.new_shape()
            shape.draw_rect(rect)
            shape.finish(
                color=color,
                fill=fill_color,
                fill_opacity=0.25,
                width=1.5,
                stroke_opacity=0.8,
            )
            shape.commit()

    pdf_bytes = doc.tobytes(deflate=True)
    doc.close()
    return pdf_bytes


@app.post("/api/save-annotated")
async def save_annotated(request: AnnotateRequest):
    try:
        pdf_path = get_pdf_path(request.pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")

    symbols_dicts = [s.model_dump() for s in request.symbols]

    try:
        pdf_bytes = await run_in_thread(_annotate_pdf, str(pdf_path), symbols_dicts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Annotation failed: {str(e)}")

    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename=annotated.pdf",
        },
    )


@app.delete("/api/cache")
async def clear_cache():
    clear_page_cache()
    return {"status": "ok"}


# --- Multi-page import: sheet names, split, thumbnails ---------------------

@app.get("/api/pdf/{pdf_id}/pages", response_model=list[PageInfo])
async def list_pages(pdf_id: str):
    try:
        get_pdf_path(pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    return await run_in_thread(page_names, pdf_id)


@app.post("/api/split-pdf", response_model=list[SplitItem])
async def split_pdf_endpoint(request: SplitRequest):
    try:
        get_pdf_path(request.pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    if not request.pages:
        raise HTTPException(status_code=400, detail="No pages selected")
    items = await run_in_thread(split_pdf, request.pdf_id, request.pages)
    for it in items:
        prepare_tiles(it["pdf_id"])
    return items


@app.get("/api/pdf/{pdf_id}/thumbnail")
async def pdf_thumbnail(pdf_id: str):
    try:
        path = await run_in_thread(thumbnail_path, pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    return FileResponse(str(path), media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.api_route("/api/pdf/{pdf_id}/nobg", methods=["GET", "HEAD"])
async def pdf_no_background(pdf_id: str):
    """Same PDF with the architectural (xref) layers hidden. 404 'no-layers' if it has none."""
    try:
        path = await run_in_thread(nobg_pdf_path, pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    except NoLayersError:
        raise HTTPException(status_code=404, detail="no-layers")
    return FileResponse(str(path), media_type="application/pdf",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600"})


@app.get("/api/pdf/{pdf_id}/clip")
async def pdf_clip(pdf_id: str, x: float, y: float, w: float, h: float, z: float = 12, pad: float = 0.6, nobg: int = 0):
    """Small region of page 1 rasterised at z px/pt - used to tint matched symbols at any zoom."""
    try:
        get_pdf_path(pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    if w <= 0 or h <= 0 or w > 600 or h > 600:
        raise HTTPException(status_code=400, detail="bad clip size")
    try:
        png = await run_in_thread(render_clip, pdf_id, x, y, w, h, z, pad, bool(nobg))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.post("/api/ai-count/{pdf_id}")
async def ai_count(pdf_id: str, request: AiCountRequest | None = None):
    """Agentic AI takeoff on one sheet, restricted to the given targets (or the
    sheet's legend when none are given). Streams status / item / done events."""
    try:
        get_pdf_path(pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    targets = [t.model_dump() for t in (request.targets if request else [])]

    async def gen():
        async for ev in iterate_in_threadpool(run_ai_count(pdf_id, targets)):
            yield {"event": ev.get("type", "status"), "data": json.dumps(ev)}

    return EventSourceResponse(gen())


# --- Deep Zoom tiles ------------------------------------------------------

@app.post("/api/tiles/{pdf_id}/prepare")
async def tiles_prepare(pdf_id: str):
    try:
        return prepare_tiles(pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")


@app.get("/api/tiles/{pdf_id}/status")
async def tiles_status_endpoint(pdf_id: str):
    try:
        get_pdf_path(pdf_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF not found")
    return tiles_status(pdf_id)


# .dzi descriptors and tile PNGs; mounted last so the API routes above win.
app.mount("/api/tilefiles", StaticFiles(directory=str(TILES_DIR)), name="tilefiles")
