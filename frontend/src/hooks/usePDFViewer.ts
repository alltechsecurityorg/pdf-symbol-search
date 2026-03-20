import { useRef, useState, useCallback, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

export function usePDFViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState<PDFPageProxy | null>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [scale, setScale] = useState(1.0);
  const [renderScale, setRenderScale] = useState(1.0);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const renderTaskRef = useRef<any>(null);
  const renderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDocument = useCallback(async (url: string) => {
    setLoading(true);
    try {
      const doc = await pdfjsLib.getDocument(url).promise;
      setPdfDoc(doc);
      setPageCount(doc.numPages);
      setPageNum(1);
      setScale(1.0);
      setRenderScale(1.0);
    } catch (err) {
      console.error('Failed to load PDF:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const renderPage = useCallback(
    async (doc: PDFDocumentProxy, num: number, s: number) => {
      const page = await doc.getPage(num);
      setCurrentPage(page);

      const vp = page.getViewport({ scale: s });
      setViewport(vp);

      const canvas = canvasRef.current;
      if (!canvas) return;

      // Cancel any in-progress render
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // ignore
        }
      }

      canvas.width = vp.width;
      canvas.height = vp.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const renderTask = page.render({
        canvas: canvas,
        canvasContext: ctx,
        viewport: vp,
      });
      renderTaskRef.current = renderTask;

      try {
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelled') {
          console.error('Render failed:', err);
        }
      }
    },
    []
  );

  // Re-render when pdf doc, page number, or renderScale changes
  useEffect(() => {
    if (pdfDoc) {
      renderPage(pdfDoc, pageNum, renderScale);
    }
  }, [pdfDoc, pageNum, renderScale, renderPage]);

  // Smooth zoom for continuous input (wheel) — debounces the expensive PDF re-render
  const setZoom = useCallback((newScale: number) => {
    const clamped = Math.min(Math.max(newScale, 0.25), 5.0);
    setScale(clamped);

    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    renderDebounceRef.current = setTimeout(() => {
      setRenderScale(clamped);
    }, 150);
  }, []);

  // Immediate zoom for discrete input (buttons) — renders right away
  const setZoomImmediate = useCallback((newScale: number) => {
    const clamped = Math.min(Math.max(newScale, 0.25), 5.0);
    setScale(clamped);
    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    setRenderScale(clamped);
  }, []);

  const zoomIn = useCallback(() => {
    setScale((s) => {
      const ns = Math.min(s + 0.25, 5.0);
      if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
      setRenderScale(ns);
      return ns;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const ns = Math.max(s - 0.25, 0.25);
      if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
      setRenderScale(ns);
      return ns;
    });
  }, []);

  const goToPage = useCallback(
    (num: number) => {
      if (num >= 1 && num <= pageCount) {
        setPageNum(num);
      }
    },
    [pageCount]
  );

  const fitToWidth = useCallback(() => {
    if (!containerRef.current || !currentPage) return;
    const containerWidth = containerRef.current.clientWidth;
    const pageWidth = currentPage.getViewport({ scale: 1.0 }).width;
    const newScale = Math.min(Math.max((containerWidth - 40) / pageWidth, 0.25), 5.0);
    setScale(newScale);
    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    setRenderScale(newScale);
  }, [currentPage]);

  return {
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
  };
}
