import type { PageViewport } from 'pdfjs-dist';

/**
 * Convert PDF point coordinates to screen pixel coordinates
 * using the current PDF.js viewport.
 */
export function pdfToScreen(
  viewport: PageViewport,
  pdfX: number,
  pdfY: number
): [number, number] {
  const [screenX, screenY] = viewport.convertToViewportPoint(pdfX, pdfY);
  return [screenX, screenY];
}

/**
 * Convert screen pixel coordinates to PDF point coordinates.
 */
export function screenToPdf(
  viewport: PageViewport,
  screenX: number,
  screenY: number
): [number, number] {
  const transform = viewport.transform;
  // Invert the viewport transform:
  // viewport transform is [a, b, c, d, e, f]
  // screenX = a * pdfX + c * pdfY + e
  // screenY = b * pdfX + d * pdfY + f
  const [a, b, c, d, e, f] = transform;
  const det = a * d - b * c;
  const pdfX = (d * (screenX - e) - c * (screenY - f)) / det;
  const pdfY = (-b * (screenX - e) + a * (screenY - f)) / det;
  return [pdfX, pdfY];
}

/**
 * Convert a hex color string to an rgba string with given opacity.
 */
export function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
