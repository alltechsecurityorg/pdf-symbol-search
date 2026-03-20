import { useCallback, useRef } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { pdfToScreen, hexToRgba } from '../utils/coordinates';
import type { SymbolTemplate } from '../store/appStore';

export function useOverlay() {
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const drawOverlays = useCallback(
    (
      viewport: PageViewport | null,
      symbols: SymbolTemplate[],
      currentPage: number,
      pdfCanvasWidth: number,
      pdfCanvasHeight: number
    ) => {
      const canvas = overlayRef.current;
      if (!canvas || !viewport) return;

      canvas.width = pdfCanvasWidth;
      canvas.height = pdfCanvasHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const symbol of symbols) {
        if (!symbol.visible) continue;

        const pageMatches = symbol.matches.filter(
          (m) => m.page === currentPage
        );

        for (const match of pageMatches) {
          const [screenX, screenY] = pdfToScreen(viewport, match.x, match.y);
          const screenWidth = match.width * viewport.scale;
          const screenHeight = match.height * viewport.scale;

          // Fill with 30% opacity
          ctx.fillStyle = hexToRgba(symbol.color, 0.3);
          ctx.fillRect(screenX, screenY, screenWidth, screenHeight);

          // Border at 100% opacity
          ctx.strokeStyle = symbol.color;
          ctx.lineWidth = 2;
          ctx.strokeRect(screenX, screenY, screenWidth, screenHeight);
        }
      }
    },
    []
  );

  const getMatchAtPoint = useCallback(
    (
      viewport: PageViewport | null,
      symbols: SymbolTemplate[],
      currentPage: number,
      screenX: number,
      screenY: number
    ): { symbol: SymbolTemplate; match: SymbolTemplate['matches'][0] } | null => {
      if (!viewport) return null;

      for (const symbol of symbols) {
        if (!symbol.visible) continue;

        const pageMatches = symbol.matches.filter((m) => m.page === currentPage);

        for (const match of pageMatches) {
          const [mx, my] = pdfToScreen(viewport, match.x, match.y);
          const mw = match.width * viewport.scale;
          const mh = match.height * viewport.scale;

          if (
            screenX >= mx &&
            screenX <= mx + mw &&
            screenY >= my &&
            screenY <= my + mh
          ) {
            return { symbol, match };
          }
        }
      }

      return null;
    },
    []
  );

  return {
    overlayRef,
    drawOverlays,
    getMatchAtPoint,
  };
}
