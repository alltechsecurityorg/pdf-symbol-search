import { useEffect, useRef } from 'react';

interface CropSelectorProps {
  canvasWidth: number;
  canvasHeight: number;
  cropRect: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null;
  isActive: boolean;
}

export function CropSelector({
  canvasWidth,
  canvasHeight,
  cropRect,
  isActive,
}: CropSelectorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!cropRect || !isActive) return;

    const x = Math.min(cropRect.startX, cropRect.endX);
    const y = Math.min(cropRect.startY, cropRect.endY);
    const w = Math.abs(cropRect.endX - cropRect.startX);
    const h = Math.abs(cropRect.endY - cropRect.startY);

    // Draw dimming overlay outside crop area
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.clearRect(x, y, w, h);

    // Draw dashed border
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#00aaff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // Draw corner handles
    ctx.setLineDash([]);
    ctx.fillStyle = '#00aaff';
    const handleSize = 6;
    const corners = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ];
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
    }

    // Draw size label
    const labelW = Math.round(w);
    const labelH = Math.round(h);
    ctx.font = '11px monospace';
    ctx.fillStyle = '#00aaff';
    ctx.fillText(`${labelW} x ${labelH}`, x, y - 6);
  }, [canvasWidth, canvasHeight, cropRect, isActive]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
