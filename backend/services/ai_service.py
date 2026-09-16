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
import time

import fitz
import requests

from services.pdf_service import get_pdf_path, render_clip
from services.crop_service import crop_symbol
from services.vector_match import load_geometry, find_instances, load_index, _components
import numpy as np

logger = logging.getLogger(__name__)

API = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("AI_MODEL", "openai/gpt-6-astra")
REASONING = os.environ.get("AI_REASONING", "low")
MAX_IMAGES_KEPT = 4  # older views are pruned from the conversation to keep calls fast
COST_CAP = float(os.environ.get("AI_COST_CAP", "2.0"))
MAX_STEPS = int(os.environ.get("AI_MAX_STEPS", "24"))

TOOLS = [
    {"type": "function", "function": {
        "name": "get_view",
        "description": "Render a region of the sheet as an image. Coordinates in PDF points, origin top-left, y down. Use small regions for detail (the render is capped around 1200px).",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "number"}, "y": {"type": "number"},
            "w": {"type": "number"}, "h": {"type": "number"},
            "sheet": {"type": "string", "enum": ["drawing", "legend"], "description": "Which document to view (default drawing). 'legend' is only available when a separate legend sheet exists."},
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

SYSTEM_COMMON = """You are an expert electrical/security takeoff assistant working on one drawing sheet.

Method (follow strictly):
- For each target symbol type: get_view a close-up of one clean instance in the DRAWING AREA, then call
  count_symbol with a TIGHT box around exactly that one instance. The counter is exact-geometry: your
  box quality decides everything.
- Sanity-check each returned count against what you see; re-try a type once with a better box if it
  looks wrong. Re-counting with a name you already used REPLACES that earlier count.
- When every target is handled, call finish with a summary (mention any target that does not appear).

Rules:
- All coordinates are PDF points, origin top-left, y increases downward. Every view's caption tells you
  the exact region it covers - derive coordinates from that.
- count_symbol is EXHAUSTIVE and AUTHORITATIVE for the entire sheet. Once it returns, that target is
  DONE - never scan the sheet to visually verify or find more instances. The only reason to revisit a
  target is a clearly wrong count (e.g. 1 when you can see several): then re-box ONCE, tighter, on a
  clean instance, and accept the second result.
- Budget: at most 2 views per target before counting it. Never estimate counts visually.
- Box instances from the drawing area, never the legend's own sample symbols.
- Count ONLY the target symbol types. Do not add other symbols you happen to notice.
- When every target has a count, call finish immediately."""

SYSTEM_TARGETS = SYSTEM_COMMON + """

Your targets are EXACTLY the reference symbols provided (each with its name and image, possibly cropped
from a legend or a different sheet). Use each name verbatim in count_symbol."""

SYSTEM_LEGEND = SYSTEM_COMMON + """

Your targets are EXACTLY the symbol types defined in this sheet's legend table. First locate the legend
and view it up close; use the legend's own names. If the sheet has no legend, call finish immediately
saying a legend could not be found and nothing was counted."""

SYSTEM_LEGEND_SHEET = SYSTEM_COMMON + """

A separate LEGEND SHEET is provided for this discipline (its overview is attached; view it up close
with get_view using sheet='legend'). Your targets are EXACTLY the symbol types defined in that legend;
use the legend's own names. Count instances on the DRAWING sheet only - count_symbol always operates
on the drawing."""


def _png_msg(png: bytes, caption: str) -> dict:
    return {"role": "user", "content": [
        {"type": "text", "text": caption},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
    ]}


def _snap_box(pdf_id: str, x: float, y: float, w: float, h: float):
    """Snap a rough box to the tight bbox of the geometry cluster nearest its centre.
    Vision models point well but box poorly; the sheet's own vectors know the exact extent."""
    try:
        idx = load_index(pdf_id)
        seg = idx["seg"]
        ln = np.hypot(seg[:, 2] - seg[:, 0], seg[:, 3] - seg[:, 1])
        pad = 0.35 * max(w, h)
        m = ((ln <= 60)
             & (np.minimum(seg[:, 0], seg[:, 2]) >= x - pad) & (np.maximum(seg[:, 0], seg[:, 2]) <= x + w + pad)
             & (np.minimum(seg[:, 1], seg[:, 3]) >= y - pad) & (np.maximum(seg[:, 1], seg[:, 3]) <= y + h + pad))
        s = seg[m]
        if len(s) < 2 or len(s) > 400:
            return x, y, w, h, False
        comps = _components(np.asarray(s, dtype=np.float64))
        cx, cy = x + w / 2, y + h / 2
        best, best_d = None, 1e18
        for c in comps:
            xs = np.concatenate([c[:, 0], c[:, 2]]); ys = np.concatenate([c[:, 1], c[:, 3]])
            bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max(), ys.max()
            if bx1 - bx0 < 1.5 or by1 - by0 < 1.5 or bx1 - bx0 > 120 or by1 - by0 > 120:
                continue
            d = ((bx0 + bx1) / 2 - cx) ** 2 + ((by0 + by1) / 2 - cy) ** 2
            if d < best_d:
                best, best_d = (bx0, by0, bx1, by1), d
        if best is None:
            return x, y, w, h, False
        # merge in any other cluster overlapping the winner (multi-part glyphs)
        gx0, gy0, gx1, gy1 = best
        for c in comps:
            xs = np.concatenate([c[:, 0], c[:, 2]]); ys = np.concatenate([c[:, 1], c[:, 3]])
            bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max(), ys.max()
            if bx1 - bx0 > 120 or by1 - by0 > 120:
                continue
            if bx0 < gx1 + 1 and bx1 > gx0 - 1 and by0 < gy1 + 1 and by1 > gy0 - 1:
                gx0, gy0, gx1, gy1 = min(gx0, bx0), min(gy0, by0), max(gx1, bx1), max(gy1, by1)
        if gx1 - gx0 > 120 or gy1 - gy0 > 120:
            return x, y, w, h, False
        return float(gx0 - 0.7), float(gy0 - 0.7), float(gx1 - gx0 + 1.4), float(gy1 - gy0 + 1.4), True
    except Exception:  # noqa: BLE001
        logger.exception("snap failed")
        return x, y, w, h, False


def _view_png(pdf_id: str, x: float, y: float, w: float, h: float, max_px: float = 1200.0) -> bytes:
    """Views for the agent always use the background-hidden variant: the architectural
    underlay is pure clutter for symbol localisation (layer-less sheets get the grey filter)."""
    z = max(0.3, min(48.0, max_px / max(w, h, 1e-6)))
    return render_clip(pdf_id, x, y, w, h, z, pad=1.0, nobg=True)


def _prune_images(messages: list) -> None:
    """Keep only the newest MAX_IMAGES_KEPT view images (the two overviews at the start are
    always kept); older ones become a text stub. The API is stateless - everything is re-sent
    and re-processed each call, so stale megapixel views dominate latency and cost."""
    keep_head = 3  # system + drawing overview + optional legend overview / targets
    seen = 0
    for msg in reversed(messages[keep_head:]):
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if part.get("type") == "image_url":
                seen += 1
                if seen > MAX_IMAGES_KEPT:
                    part.clear()
                    part.update({"type": "text", "text": "[an older view was removed - request it again if needed]"})


def run_ai_count(pdf_id: str, targets: list | None = None, legend_pdf_id: str | None = None, model: str | None = None):
    """Generator of event dicts: status / item / done / error.

    targets: [{name, thumbnail(data URL)}] restricts the run to those symbols;
    without targets the run is restricted to the sheet's own legend."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        yield {"type": "error", "detail": "OPENROUTER_API_KEY not configured"}
        return
    pdf_path = get_pdf_path(pdf_id)
    doc = fitz.open(str(pdf_path))
    rect = doc[0].rect
    doc.close()
    W, H = rect.width, rect.height

    overview = _view_png(pdf_id, 0, 0, W, H, max_px=1400.0)
    targets = [t for t in (targets or []) if t.get("name") and t.get("thumbnail")]
    legend = None  # (pdf_id, W, H)
    if not targets and legend_pdf_id and legend_pdf_id != pdf_id:
        ldoc = fitz.open(str(get_pdf_path(legend_pdf_id)))
        lrect = ldoc[0].rect
        ldoc.close()
        legend = (legend_pdf_id, lrect.width, lrect.height)
    system = SYSTEM_TARGETS if targets else (SYSTEM_LEGEND_SHEET if legend else SYSTEM_LEGEND)
    messages = [
        {"role": "system", "content": system},
        _png_msg(overview, f"Overview of the DRAWING sheet. It covers x 0..{W:.0f}, y 0..{H:.0f} PDF points."),
    ]
    if legend:
        messages.append(_png_msg(_view_png(legend[0], 0, 0, legend[1], legend[2], max_px=1600.0),
                                 f"Overview of the LEGEND sheet. It covers x 0..{legend[1]:.0f}, y 0..{legend[2]:.0f} PDF points (use sheet='legend' in get_view)."))
    if targets:
        content = [{"type": "text", "text": f"Count ONLY these {len(targets)} symbol types:"}]
        for t in targets:
            content.append({"type": "text", "text": f"Target: {str(t['name'])[:60]}"})
            content.append({"type": "image_url", "image_url": {"url": t["thumbnail"]}})
        messages.append({"role": "user", "content": content})

    total_cost = 0.0
    items = 0
    by_name: dict[str, str] = {}  # name -> template_id, so a re-count replaces the earlier item
    yield {"type": "status", "text": "AI is studying the sheet…"}

    for step in range(MAX_STEPS):
        _prune_images(messages)
        t_call = time.time()
        try:
            r = requests.post(API, timeout=300,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": model or MODEL, "messages": messages, "tools": TOOLS,
                      "reasoning": {"effort": REASONING}, "usage": {"include": True},
                      "max_tokens": 4000})
            data = r.json()
        except Exception as e:  # noqa: BLE001
            yield {"type": "error", "detail": f"model call failed: {e}"}
            return
        if "error" in data:
            yield {"type": "error", "detail": str(data["error"])[:300]}
            return
        u = data.get("usage", {})
        total_cost += float(u.get("cost") or 0)
        logger.info("ai step %d: %.1fs, in=%s out=%s, run cost $%.3f", step + 1, time.time() - t_call, u.get("prompt_tokens"), u.get("completion_tokens"), total_cost)
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
                on_legend = legend is not None and args.get("sheet") == "legend"
                vid, vw, vh = (legend[0], legend[1], legend[2]) if on_legend else (pdf_id, W, H)
                x, y = float(args["x"]), float(args["y"])
                w, h = float(args["w"]), float(args["h"])
                x = max(0, min(x, vw - 1)); y = max(0, min(y, vh - 1))
                w = max(4.0, min(w, vw - x)); h = max(4.0, min(h, vh - y))
                try:
                    png = _view_png(vid, x, y, w, h)
                    result_text = f"View rendered from the {'LEGEND' if on_legend else 'DRAWING'} sheet; the attached image covers x {x:.1f}..{x+w:.1f}, y {y:.1f}..{y+h:.1f} pt."
                    pending_images.append((png, result_text))
                except Exception as e:  # noqa: BLE001
                    result_text = f"view failed: {e}"
                yield {"type": "status", "text": f"AI looks at the {'legend' if on_legend else 'drawing'} ({x:.0f},{y:.0f}) {w:.0f}x{h:.0f}pt"}
            elif fn == "count_symbol":
                name = str(args.get("name") or "Unnamed item")[:60]
                x, y = float(args["x"]), float(args["y"])
                w, h = float(args["w"]), float(args["h"])
                if w < 2 or h < 2 or w > 160 or h > 160:
                    result_text = "Rejected: symbol box must be between 2 and 160 pt per side, around one instance."
                else:
                    try:
                        x, y, w, h, snapped = _snap_box(pdf_id, x, y, w, h)
                        tpl = crop_symbol(str(pdf_path), 1, x, y, w, h)
                        geom = load_geometry(tpl["template_id"])
                        n_seg = len(geom.get("seg", [])) if geom else 0
                        if n_seg > 150:
                            # a symbol is dozens of strokes, not hundreds - this box grabbed the
                            # surroundings, and searching it would take minutes to find only itself
                            messages_note = (f"Rejected: the box captured {n_seg} line segments - far too much for one "
                                             "symbol. Zoom in closer and box ONLY the symbol, tightly.")
                            messages.append({"role": "tool", "tool_call_id": call["id"], "content": messages_note})
                            yield {"type": "status", "text": f"Box for '{name}' too loose ({n_seg} segments) - asking AI to re-box"}
                            continue
                        matches = find_instances(pdf_id, geom) if geom else []
                        for m in matches:
                            m["page"] = 1
                        segs = len(geom.get("seg", [])) if geom else 0
                        result_text = ((f"(box snapped to the symbol: {w:.1f}x{h:.1f}pt at {x:.1f},{y:.1f}) " if snapped else "")
                                       + f"'{name}': {len(matches)} instances found across the ENTIRE sheet (exhaustive; template geometry: {segs} segments)."
                                       + (" The box contained almost no vector geometry - re-check placement." if segs < 3 else "")
                                       + (" If this count is clearly below what you can see, re-box once, tighter, on a clean instance; otherwise this target is done - do not verify visually." if len(matches) <= 2 else " This target is done."))
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
