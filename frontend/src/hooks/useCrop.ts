import { useState, useCallback, useRef, type RefObject } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { screenToPdf } from '../utils/coordinates';

interface CropRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export function useCrop(
  viewport: PageViewport | null,
  pdfCanvasRef: RefObject<HTMLCanvasElement | null>
) {
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [isCropping, setIsCropping] = useState(false);
  const isDragging = useRef(false);

  const getCanvasCoords = useCallback(
    (e: React.MouseEvent) => {
      const canvas = pdfCanvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    },
    [pdfCanvasRef]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!viewport) return;
      const { x, y } = getCanvasCoords(e);
      isDragging.current = true;
      setCropRect({ startX: x, startY: y, endX: x, endY: y });
    },
    [viewport, getCanvasCoords]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging.current || !cropRect) return;
      const { x, y } = getCanvasCoords(e);
      setCropRect((prev) => (prev ? { ...prev, endX: x, endY: y } : null));
    },
    [cropRect, getCanvasCoords]
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    setIsCropping(false);
  }, []);

  const getCropRegionPdf = useCallback((): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null => {
    if (!cropRect || !viewport) return null;

    const [pdfX1, pdfY1] = screenToPdf(viewport, cropRect.startX, cropRect.startY);
    const [pdfX2, pdfY2] = screenToPdf(viewport, cropRect.endX, cropRect.endY);

    const x = Math.min(pdfX1, pdfX2);
    const y = Math.min(pdfY1, pdfY2);
    const width = Math.abs(pdfX2 - pdfX1);
    const height = Math.abs(pdfY2 - pdfY1);

    if (width < 5 || height < 5) return null;

    return { x, y, width, height };
  }, [cropRect, viewport]);

  const clearCrop = useCallback(() => {
    setCropRect(null);
    setIsCropping(false);
    isDragging.current = false;
  }, []);

  return {
    cropRect,
    isCropping,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    getCropRegionPdf,
    clearCrop,
    startCropping: () => setIsCropping(true),
  };
}
