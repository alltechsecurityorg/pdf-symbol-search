import { useEffect, useRef } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { hexToRgba } from '../utils/coordinates';
import type { SymbolTemplate } from '../store/appStore';

interface OverlayCanvasProps {
  viewport: PageViewport | null;
  symbols: SymbolTemplate[];
  currentPage: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function OverlayCanvas({
  viewport,
  symbols,
  currentPage,
  canvasWidth,
  canvasHeight,
}: OverlayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = viewport.scale;

    for (const symbol of symbols) {
      if (!symbol.visible) continue;

      const pageMatches = symbol.matches.filter((m) => m.page === currentPage);

      for (const match of pageMatches) {
        // PDF points * viewport scale = canvas pixels
        const screenX = match.x * scale;
        const screenY = match.y * scale;
        const screenWidth = match.width * scale;
        const screenHeight = match.height * scale;

        const fillOpacity = 0.15 + match.confidence * 0.2;

        ctx.fillStyle = hexToRgba(symbol.color, fillOpacity);
        ctx.fillRect(screenX, screenY, screenWidth, screenHeight);

        ctx.strokeStyle = symbol.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(screenX, screenY, screenWidth, screenHeight);
      }
    }
  }, [viewport, symbols, currentPage, canvasWidth, canvasHeight]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0"
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
}
