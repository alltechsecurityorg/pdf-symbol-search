import csv
import io


def export_csv(results: list[dict]) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["symbol_name", "match_number", "page", "x", "y", "width", "height", "confidence"])

    for symbol_result in results:
        for i, match in enumerate(symbol_result["matches"], 1):
            writer.writerow([
                symbol_result["symbol_name"],
                i,
                match["page"],
                round(match["x"], 2),
                round(match["y"], 2),
                round(match["width"], 2),
                round(match["height"], 2),
                round(match["confidence"], 4),
            ])

    return output.getvalue()
