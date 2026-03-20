import { useCallback, useEffect, useRef, useState } from 'react';
import { usePDFViewer } from '../hooks/usePDFViewer';
import { useAppStore } from '../store/appStore';
import { cropSymbol } from '../api/client';
import { OverlayCanvas } from './OverlayCanvas';
import { CropSelector } from './CropSelector';
import { Toolbar } from './Toolbar';
import { ColorPicker, PRESET_COLORS } from './ColorPicker';

const SCROLL_PAD = 40;

export function PDFViewer() {
  const {
    canvasRef,
    containerRef,
    viewport,
    scale,
    renderScale,
    pageNum,
    pageCount,
    loading,
    loadDocument,
    zoomIn,
    zoomOut,
    setZoom,
    setZoomImmediate,
    goToPage,
    fitToWidth,
  } = usePDFViewer();

  const {
    legendPdf,
    sitePdf,
    activeView,
    setActiveView,
    symbols,
    isCropMode,
    manualModeSymbolId,
    setIsCropMode,
    addSymbol,
    addManualMatch,
    removeMatch,
    undo,
    focusMatch,
    setCurrentPage,
    setZoomLevel,
  } = useAppStore();

  const activePdf = activeView === 'legend' ? legendPdf : sitePdf;
  const pdfId = activePdf?.pdfId ?? null;
  const pdfUrl = activePdf?.pdfUrl ?? null;
  const isSiteView = activeView === 'site';

  // Refs to track latest scale values for native event handlers
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  const renderScaleRef = useRef(renderScale);
  useEffect(() => { renderScaleRef.current = renderScale; }, [renderScale]);

  // Canvas wrapper ref for layout queries during zoom
  const canvasWrapperRef = useRef<HTMLDivElement>(null);

  // Pan state (drag-to-scroll)
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const scrollStartRef = useRef({ x: 0, y: 0 });

  // Crop state
  const [cropRect, setCropRect] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);
  const isCroppingRef = useRef(false);

  // Track mouse movement to distinguish clicks from drags
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  // Modal state
  const [showCropModal, setShowCropModal] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<{
    thumbnail: string;
    templateId: string;
    cropRegion: { page: number; x: number; y: number; width: number; height: number };
  } | null>(null);
  const [newSymbolName, setNewSymbolName] = useState('');
  const [newSymbolColor, setNewSymbolColor] = useState(PRESET_COLORS[0]);

  // CSS zoom multiplier (visual scale / rendered scale)
  const cssZoom = renderScale > 0 ? scale / renderScale : 1;
  const canvasW = canvasRef.current?.width ?? 0;
  const canvasH = canvasRef.current?.height ?? 0;
  const visualW = canvasW * cssZoom;
  const visualH = canvasH * cssZoom;

  // Load PDF when URL changes
  useEffect(() => {
    if (pdfUrl) {
      loadDocument(pdfUrl);
    }
  }, [pdfUrl, loadDocument]);

  // Sync page num with store
  useEffect(() => {
    setCurrentPage(pageNum);
  }, [pageNum, setCurrentPage]);

  // Sync zoom with store
  useEffect(() => {
    setZoomLevel(scale);
  }, [scale, setZoomLevel]);

  // Auto-pick next color for new symbol
  useEffect(() => {
    const usedColors = symbols.map((s) => s.color);
    const nextColor =
      PRESET_COLORS.find((c) => !usedColors.includes(c)) || PRESET_COLORS[0];
    setNewSymbolColor(nextColor);
  }, [symbols]);

  // --- Ctrl+Z undo shortcut ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo]);

  // --- Navigate to focused match ---
  useEffect(() => {
    if (!focusMatch) return;
    const container = containerRef.current;
    if (!container) return;

    // Switch to site view if viewing legend (matches live on site PDF)
    if (!isSiteView && sitePdf) {
      setActiveView('site');
      loadDocument(sitePdf.pdfUrl);
    }

    // Navigate to the correct page
    if (focusMatch.page !== pageNum) {
      goToPage(focusMatch.page);
    }

    // Choose a zoom level that makes the symbol ~250px on screen
    const symbolSize = Math.max(focusMatch.width, focusMatch.height);
    const targetVisualSize = 250;
    const desiredScale = Math.min(Math.max(targetVisualSize / symbolSize, 1.0), 4.0);

    setZoomImmediate(desiredScale);

    // After render, scroll to center the match
    // Use a small delay to let the page render and layout update
    const timer = setTimeout(() => {
      const wrapper = canvasWrapperRef.current;
      if (!wrapper || !container) return;

      const currentRenderScale = desiredScale;
      // Match center in PDF points → visual pixels
      const matchCenterX = (focusMatch.x + focusMatch.width / 2) * currentRenderScale;
      const matchCenterY = (focusMatch.y + focusMatch.height / 2) * currentRenderScale;

      const wrapperLeft = wrapper.offsetLeft;
      const wrapperTop = wrapper.offsetTop;

      container.scrollLeft = wrapperLeft + matchCenterX - container.clientWidth / 2;
      container.scrollTop = wrapperTop + matchCenterY - container.clientHeight / 2;
    }, 200);

    return () => clearTimeout(timer);
  }, [focusMatch?._seq]);

  // --- Smooth scroll-wheel zoom (cursor-centered) ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const currentScale = scaleRef.current;
      const currentRenderScale = renderScaleRef.current;
      const cW = canvasRef.current?.width ?? 0;
      const cH = canvasRef.current?.height ?? 0;

      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // --- Zoom ---
        const rect = container.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        // Find canvas wrapper position in scroll content
        const wrapper = canvasWrapperRef.current;
        const wrapperLeft = wrapper ? wrapper.offsetLeft : SCROLL_PAD;
        const wrapperTop = wrapper ? wrapper.offsetTop : SCROLL_PAD;

        // Cursor position relative to canvas content
        const canvasRelX = container.scrollLeft + cursorX - wrapperLeft;
        const canvasRelY = container.scrollTop + cursorY - wrapperTop;

        const zoomFactor = e.deltaY < 0 ? 1.03 : 1 / 1.03;
        const newScale = Math.min(Math.max(currentScale * zoomFactor, 0.25), 5.0);
        const ratio = newScale / currentScale;

        // Compute new visual dimensions
        const newCssZoom = currentRenderScale > 0 ? newScale / currentRenderScale : 1;
        const newVisualW = cW * newCssZoom;
        const newVisualH = cH * newCssZoom;

        // Estimate new wrapper position (centered layout)
        const newContentW = newVisualW + SCROLL_PAD * 2;
        const newContentH = newVisualH + SCROLL_PAD * 2;
        const effectiveContentW = Math.max(newContentW, container.clientWidth);
        const effectiveContentH = Math.max(newContentH, container.clientHeight);
        const newWrapperLeft = (effectiveContentW - newVisualW) / 2;
        const newWrapperTop = (effectiveContentH - newVisualH) / 2;

        const newScrollLeft = newWrapperLeft + canvasRelX * ratio - cursorX;
        const newScrollTop = newWrapperTop + canvasRelY * ratio - cursorY;

        setZoom(newScale);

        requestAnimationFrame(() => {
          container.scrollLeft = Math.max(0, newScrollLeft);
          container.scrollTop = Math.max(0, newScrollTop);
        });
      } else {
        // --- Pan via trackpad gesture ---
        container.scrollLeft += e.deltaX;
        container.scrollTop += e.deltaY;
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [setZoom, containerRef, canvasRef]);

  // --- Mouse coordinate helpers ---
  const getCanvasPixel = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    },
    [canvasRef]
  );

  const canvasPixelToPdf = useCallback(
    (px: number, py: number) => {
      if (!viewport) return { x: 0, y: 0 };
      return {
        x: px / viewport.scale,
        y: py / viewport.scale,
      };
    },
    [viewport]
  );

  // --- Find match under a PDF point ---
  const findMatchAtPoint = useCallback(
    (pdfX: number, pdfY: number) => {
      for (const symbol of symbols) {
        if (!symbol.visible) continue;
        const pageMatches = symbol.matches
          .map((m, idx) => ({ ...m, idx }))
          .filter((m) => m.page === pageNum);

        for (const match of pageMatches) {
          if (
            pdfX >= match.x &&
            pdfX <= match.x + match.width &&
            pdfY >= match.y &&
            pdfY <= match.y + match.height
          ) {
            return { symbolId: symbol.id, matchIndex: match.idx };
          }
        }
      }
      return null;
    },
    [symbols, pageNum]
  );

  // --- Mouse handlers for pan / crop / manual ---
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };

      if (isCropMode) {
        const pt = getCanvasPixel(e);
        isCroppingRef.current = true;
        setCropRect({ startX: pt.x, startY: pt.y, endX: pt.x, endY: pt.y });
      } else if (!manualModeSymbolId) {
        // Drag-to-pan via scroll
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        const container = containerRef.current;
        if (container) {
          scrollStartRef.current = {
            x: container.scrollLeft,
            y: container.scrollTop,
          };
        }
      }
    },
    [isCropMode, manualModeSymbolId, getCanvasPixel, containerRef]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isCropMode && isCroppingRef.current) {
        const pt = getCanvasPixel(e);
        setCropRect((prev) => (prev ? { ...prev, endX: pt.x, endY: pt.y } : null));
      } else if (isPanningRef.current) {
        const container = containerRef.current;
        if (container) {
          const dx = e.clientX - panStartRef.current.x;
          const dy = e.clientY - panStartRef.current.y;
          container.scrollLeft = scrollStartRef.current.x - dx;
          container.scrollTop = scrollStartRef.current.y - dy;
        }
      }
    },
    [isCropMode, getCanvasPixel, containerRef]
  );

  const handleMouseUp = useCallback(
    async (e: React.MouseEvent) => {
      const downPos = mouseDownPosRef.current;
      mouseDownPosRef.current = null;

      if (isCropMode && isCroppingRef.current && cropRect) {
        isCroppingRef.current = false;

        if (!pdfId || !viewport) {
          setCropRect(null);
          return;
        }

        const p1 = canvasPixelToPdf(cropRect.startX, cropRect.startY);
        const p2 = canvasPixelToPdf(cropRect.endX, cropRect.endY);

        const x = Math.min(p1.x, p2.x);
        const y = Math.min(p1.y, p2.y);
        const width = Math.abs(p2.x - p1.x);
        const height = Math.abs(p2.y - p1.y);

        setCropRect(null);

        if (width < 5 || height < 5) return;

        try {
          const result = await cropSymbol({
            pdf_id: pdfId,
            page: pageNum,
            x,
            y,
            width,
            height,
          });

          setPendingCrop({
            thumbnail: result.thumbnail_base64,
            templateId: result.template_id,
            cropRegion: { page: pageNum, x, y, width, height },
          });
          setNewSymbolName('');
          setShowCropModal(true);
        } catch (err) {
          console.error('Crop failed:', err);
          alert('Failed to crop symbol');
        }

        setIsCropMode(false);
      } else if (manualModeSymbolId && isSiteView && downPos) {
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < 5 && viewport) {
          const pt = getCanvasPixel(e);
          const pdfPt = canvasPixelToPdf(pt.x, pt.y);

          const symbol = symbols.find((s) => s.id === manualModeSymbolId);
          if (symbol) {
            const matchWidth = symbol.cropRegion.width;
            const matchHeight = symbol.cropRegion.height;

            addManualMatch(manualModeSymbolId, {
              page: pageNum,
              x: pdfPt.x - matchWidth / 2,
              y: pdfPt.y - matchHeight / 2,
              width: matchWidth,
              height: matchHeight,
              confidence: 1.0,
              manual: true,
            });
          }
        }
      } else {
        isPanningRef.current = false;
      }
    },
    [
      isCropMode, cropRect, pdfId, viewport, pageNum,
      canvasPixelToPdf, setIsCropMode, manualModeSymbolId,
      symbols, getCanvasPixel, addManualMatch,
    ]
  );

  const handleMouseLeave = useCallback(() => {
    isPanningRef.current = false;
    mouseDownPosRef.current = null;
    if (isCroppingRef.current) {
      isCroppingRef.current = false;
      setCropRect(null);
    }
  }, []);

  // --- Double-click to remove a match ---
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!viewport) return;

      const pt = getCanvasPixel(e);
      const pdfPt = canvasPixelToPdf(pt.x, pt.y);

      const hit = findMatchAtPoint(pdfPt.x, pdfPt.y);
      if (hit) {
        removeMatch(hit.symbolId, hit.matchIndex);
      }
    },
    [viewport, getCanvasPixel, canvasPixelToPdf, findMatchAtPoint, removeMatch]
  );

  const handleConfirmSymbol = () => {
    if (!pendingCrop) return;

    addSymbol({
      name: newSymbolName || 'Unnamed Symbol',
      color: newSymbolColor,
      thumbnail: pendingCrop.thumbnail,
      cropRegion: pendingCrop.cropRegion,
      templateId: pendingCrop.templateId,
    });

    setShowCropModal(false);
    setPendingCrop(null);
  };

  const getCursor = () => {
    if (isCropMode) return 'crosshair';
    if (manualModeSymbolId) return 'cell';
    if (isPanningRef.current) return 'grabbing';
    return 'grab';
  };

  return (
    <div className="flex flex-col flex-1 min-w-0">
      <Toolbar
        scale={scale}
        pageNum={pageNum}
        pageCount={pageCount}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFitToWidth={fitToWidth}
        onGoToPage={goToPage}
        onLoadPdf={loadDocument}
      />

      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-[#2a2a2a] relative"
      >
        {!pdfUrl && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 pointer-events-none z-10">
            <div className="text-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-16 h-16 mx-auto mb-4 opacity-30"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-lg">Open a PDF to get started</p>
              <p className="text-sm mt-1">Load a Legend PDF to crop symbols, or a Site Plan to search</p>
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-30 pointer-events-none">
            <div className="text-blue-400 text-lg">Loading PDF...</div>
          </div>
        )}

        {/* Scrollable content wrapper — flex centers the canvas when it's smaller than viewport */}
        <div
          className="inline-flex items-center justify-center"
          style={{
            minWidth: '100%',
            minHeight: '100%',
            padding: `${SCROLL_PAD}px`,
          }}
        >
          {/* Sizing wrapper — sets layout dimensions to the visual (CSS-zoomed) size */}
          <div
            ref={canvasWrapperRef}
            className="relative flex-shrink-0"
            style={{
              width: `${visualW}px`,
              height: `${visualH}px`,
              cursor: getCursor(),
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onDoubleClick={handleDoubleClick}
          >
            {/* CSS transform wrapper — scales canvas for instant visual zoom */}
            <div
              style={{
                transform: `scale(${cssZoom})`,
                transformOrigin: '0 0',
                willChange: 'transform',
              }}
            >
              <div className="relative inline-block shadow-2xl">
                <canvas ref={canvasRef} style={{ display: 'block' }} />

                <OverlayCanvas
                  viewport={viewport}
                  symbols={isSiteView ? symbols : []}
                  currentPage={pageNum}
                  canvasWidth={canvasW}
                  canvasHeight={canvasH}
                />

                {isCropMode && (
                  <CropSelector
                    canvasWidth={canvasW}
                    canvasHeight={canvasH}
                    cropRect={cropRect}
                    isActive={isCropMode}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Crop confirmation modal */}
      {showCropModal && pendingCrop && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#16213e] border border-[#1e3a5f] rounded-xl p-6 w-96 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-4">Add Symbol</h3>

            <div className="flex justify-center mb-4">
              <img
                src={pendingCrop.thumbnail}
                alt="Cropped symbol"
                className="max-w-32 max-h-32 border border-[#334155] rounded bg-white p-1"
              />
            </div>

            <div className="mb-3">
              <label className="block text-sm text-gray-400 mb-1">Symbol Name</label>
              <input
                type="text"
                value={newSymbolName}
                onChange={(e) => setNewSymbolName(e.target.value)}
                placeholder="e.g. Smoke Detector"
                autoFocus
                className="w-full bg-[#0f1629] border border-[#334155] rounded-lg px-3 py-2 text-white text-sm outline-none focus:border-blue-500"
                onKeyDown={(e) => e.key === 'Enter' && handleConfirmSymbol()}
              />
            </div>

            <div className="mb-5">
              <label className="block text-sm text-gray-400 mb-1.5">
                Highlight Color
              </label>
              <ColorPicker color={newSymbolColor} onChange={setNewSymbolColor} />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowCropModal(false);
                  setPendingCrop(null);
                }}
                className="flex-1 px-4 py-2 bg-[#1e3a5f] hover:bg-[#254a75] rounded-lg text-sm text-gray-300 cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSymbol}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white cursor-pointer transition-colors font-medium"
              >
                Add Symbol
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
