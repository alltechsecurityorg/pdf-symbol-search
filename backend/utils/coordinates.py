RENDER_DPI = 300
PDF_DPI = 72
SCALE_FACTOR = RENDER_DPI / PDF_DPI  # 4.1667


def pdf_points_to_pixels(value: float) -> float:
    return value * SCALE_FACTOR


def pixels_to_pdf_points(value: float) -> float:
    return value * (PDF_DPI / RENDER_DPI)


def pixel_match_to_pdf_coords(match: dict) -> dict:
    scale = PDF_DPI / RENDER_DPI
    return {
        "x": match["x_px"] * scale,
        "y": match["y_px"] * scale,
        "width": match["w_px"] * scale,
        "height": match["h_px"] * scale,
        "confidence": match["confidence"],
    }
