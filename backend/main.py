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
)
from services.pdf_service import save_pdf, get_pdf_path
from services.crop_service import crop_symbol
from services.search_service import run_search, render_page, rescale_template, get_template, match_symbol_on_page, pixel_to_pdf_coords, clear_page_cache
from services.vector_service import load_vector_data, get_page_drawings
from services.text_service import get_page_text_blocks
from services.export_service import export_csv
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
