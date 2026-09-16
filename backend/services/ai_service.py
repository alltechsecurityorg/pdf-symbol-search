"""AI count: an agentic loop where a vision model explores the sheet and delegates
exhaustive counting to the exact geometry matcher.

The model never counts by eye. It looks at views (clip renders at any zoom), decides
what the distinct symbol types are, boxes ONE clean instance of each, and calls
count_symbol - which runs the same crop + vector-match pipeline a human box does.
Runs are cost-capped; every model reply and tool call is streamed to the client.
"""
import base64
import json
import logging
import os

import fitz
import requests

from services.pdf_service import get_pdf_path, render_clip
from services.crop_service import crop_symbol
from services.vector_match import load_geometry, find_instances

logger = logging.getLogger(__name__)

API = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("AI_MODEL", "openai/gpt-6-astra")
COST_CAP = float(os.environ.get("AI_COST_CAP", "2.0"))
MAX_STEPS = int(os.environ.get("AI_MAX_STEPS", "24"))

TOOLS = [
    {"type": "function", "function": {
        "name": "get_view",
        "description": "Render a region of the sheet as an image. Coordinates in PDF points, origin top-left, y down. Use small regions for detail (the render is capped around 1200px).",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "number"}, "y": {"type": "number"},
            "w": {"type": "number"}, "h": {"type": "number"},
        }, "required": ["x", "y", "w", "h"]}}},
    {"type": "function", "function": {
        "name": "count_symbol",
        "description": "Count every occurrence of a symbol on the sheet with exact geometry matching. Box exactly ONE clean instance, tightly: include the whole symbol, exclude wires/walls/text that are not part of it. Returns the total found. If the count looks too low, try again with a cleaner or tighter box on a different instance.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string", "description": "What this symbol is, from the legend if available (e.g. 'Smoke detector')"},
            "x": {"type": "number"}, "y": {"type": "number"},
            "w": {"type": "number"}, "h": {"type": "number"},
        }, "required": ["name", "x", "y", "w", "h"]}}},
    {"type": "function", "function": {
        "name": "finish",
        "description": "End the takeoff with a one-paragraph summary of what was counted and anything uncertain.",
        "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}}},
]

SYSTEM = """You are an expert electrical/security takeoff assistant working on one drawing sheet.
Your job: identify every distinct COUNTABLE point symbol on the sheet and count each type.

Method (follow strictly):
1. Study the overview. If the sheet has a legend, view it up close and use its names.
2. Work out the distinct symbol types present in the drawing area (ignore title block, notes, grids, dimensions, room labels).
3. For each type: get_view a close-up of one clean instance, then call count_symbol with a TIGHT box
   around exactly that one instance. The counter is exact-geometry: your box quality decides everything.
4. Sanity-check each returned count against what you see; re-try a type once with a better box if it looks wrong.
5. Re-counting with a name you already used REPLACES that earlier count - do this to fix a bad box.
6. call finish with a summary.

Rules:
- All coordinates are PDF points, origin top-left, y increases downward. Every view's caption tells you
  the exact region it covers - derive coordinates from that.
- Never estimate counts visually; only count_symbol counts.
- Do not count the legend's own sample symbols; count_symbol already excludes nothing, so box instances
  from the drawing area, not the legend.
- Be economical: few, purposeful views."""


def _png_msg(png: bytes, caption: str) -> dict:
    return {"role": "user", "content": [
        {"type": "text", "text": caption},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
    ]}


def _view_png(pdf_id: str, x: float, y: float, w: float, h: float) -> bytes:
    z = max(1.0, min(48.0, 1200.0 / max(w, h, 1e-6)))
    return render_clip(pdf_id, x, y, w, h, z, pad=1.0)


def run_ai_count(pdf_id: str):
    """Generator of event dicts: status / item / done / error."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        yield {"type": "error", "detail": "OPENROUTER_API_KEY not configured"}
        return
    pdf_path = get_pdf_path(pdf_id)
    doc = fitz.open(str(pdf_path))
    rect = doc[0].rect
    doc.close()
    W, H = rect.width, rect.height

    overview = _view_png(pdf_id, 0, 0, W, H)
    messages = [
        {"role": "system", "content": SYSTEM},
        _png_msg(overview, f"Overview of the sheet. It covers x 0..{W:.0f}, y 0..{H:.0f} PDF points."),
    ]

    total_cost = 0.0
    items = 0
    by_name: dict[str, str] = {}  # name -> template_id, so a re-count replaces the earlier item
    yield {"type": "status", "text": "AI is studying the sheet…"}

    for step in range(MAX_STEPS):
        try:
            r = requests.post(API, timeout=300,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": MODEL, "messages": messages, "tools": TOOLS,
                      "reasoning": {"effort": "medium"}, "usage": {"include": True},
                      "max_tokens": 4000})
            data = r.json()
        except Exception as e:  # noqa: BLE001
            yield {"type": "error", "detail": f"model call failed: {e}"}
            return
        if "error" in data:
            yield {"type": "error", "detail": str(data["error"])[:300]}
            return
        total_cost += float(data.get("usage", {}).get("cost") or 0)
        msg = data["choices"][0]["message"]
        messages.append({k: v for k, v in msg.items() if k in ("role", "content", "tool_calls") and v is not None})

        if msg.get("content"):
            text = msg["content"] if isinstance(msg["content"], str) else ""
            if text.strip():
                yield {"type": "status", "text": text.strip()[:300]}

        calls = msg.get("tool_calls") or []
        if not calls:
            # model stopped talking without finish(); treat its last text as the summary
            yield {"type": "done", "summary": (msg.get("content") or "Finished."), "cost": round(total_cost, 3), "items": items}
            return

        pending_images = []
        for call in calls:
            fn = call["function"]["name"]
            try:
                args = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            result_text = ""
            if fn == "get_view":
                x, y = float(args["x"]), float(args["y"])
                w, h = float(args["w"]), float(args["h"])
                x = max(0, min(x, W - 1)); y = max(0, min(y, H - 1))
                w = max(4.0, min(w, W - x)); h = max(4.0, min(h, H - y))
                try:
                    png = _view_png(pdf_id, x, y, w, h)
                    result_text = f"View rendered; the attached image covers x {x:.1f}..{x+w:.1f}, y {y:.1f}..{y+h:.1f} pt."
                    pending_images.append((png, result_text))
                except Exception as e:  # noqa: BLE001
                    result_text = f"view failed: {e}"
                yield {"type": "status", "text": f"AI looks at ({x:.0f},{y:.0f}) {w:.0f}x{h:.0f}pt"}
            elif fn == "count_symbol":
                name = str(args.get("name") or "Unnamed item")[:60]
                x, y = float(args["x"]), float(args["y"])
                w, h = float(args["w"]), float(args["h"])
                if w < 2 or h < 2 or w > 120 or h > 120:
                    result_text = "Rejected: symbol box must be between 2 and 120 pt per side, tightly around one instance."
                else:
                    try:
                        tpl = crop_symbol(str(pdf_path), 1, x, y, w, h)
                        geom = load_geometry(tpl["template_id"])
                        matches = find_instances(pdf_id, geom) if geom else []
                        for m in matches:
                            m["page"] = 1
                        segs = len(geom.get("seg", [])) if geom else 0
                        result_text = (f"'{name}': {len(matches)} instances found (template geometry: {segs} segments)."
                                       + (" The box contained almost no vector geometry - re-check placement." if segs < 3 else ""))
                        if matches:
                            replaces = by_name.get(name)
                            if replaces is None:
                                items += 1
                            by_name[name] = tpl["template_id"]
                            yield {"type": "item", "template_id": tpl["template_id"], "name": name,
                                   "thumbnail": tpl["thumbnail_base64"], "replaces": replaces,
                                   "crop_region": {"page": 1, "x": x, "y": y, "width": w, "height": h},
                                   "matches": matches}
                        yield {"type": "status", "text": f"Counted '{name}': {len(matches)}"}
                    except Exception as e:  # noqa: BLE001
                        logger.exception("count_symbol failed")
                        result_text = f"count failed: {e}"
            elif fn == "finish":
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": "done"})
                yield {"type": "done", "summary": str(args.get("summary") or ""), "cost": round(total_cost, 3), "items": items}
                return
            else:
                result_text = f"unknown tool {fn}"
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result_text or "ok"})

        for png, caption in pending_images:
            messages.append(_png_msg(png, caption))

        if total_cost >= COST_CAP:
            yield {"type": "done", "summary": f"Stopped at the ${COST_CAP:.2f} cost cap.", "cost": round(total_cost, 3), "items": items}
            return

    yield {"type": "done", "summary": "Stopped at the step limit.", "cost": round(total_cost, 3), "items": items}
