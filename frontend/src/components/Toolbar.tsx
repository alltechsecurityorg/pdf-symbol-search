import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { PdfInfo } from '../store/appStore';
import { uploadPdf, getPdfUrl } from '../api/client';

interface ToolbarProps {
  scale: number;
  pageNum: number;
  pageCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToWidth: () => void;
  onGoToPage: (page: number) => void;
  onLoadPdf: (url: string) => void;
}

export function Toolbar({
  scale,
  pageNum,
  pageCount,
  onZoomIn,
  onZoomOut,
  onFitToWidth,
  onGoToPage,
  onLoadPdf,
}: ToolbarProps) {
  const legendInputRef = useRef<HTMLInputElement>(null);
  const siteInputRef = useRef<HTMLInputElement>(null);
  const {
    legendPdf,
    sitePdf,
    activeView,
    setLegendPdf,
    setSitePdf,
    setActiveView,
    undo,
    undoStack,
  } = useAppStore();

  const handleUpload = async (file: File, target: 'legend' | 'site') => {
    try {
      const result = await uploadPdf(file);
      const url = getPdfUrl(result.pdf_id);
      const info: PdfInfo = {
        pdfId: result.pdf_id,
        pdfUrl: url,
        filename: result.filename,
        pageCount: result.page_count,
        pageSizes: result.page_sizes,
      };
      if (target === 'legend') {
        setLegendPdf(info);
      } else {
        setSitePdf(info);
      }
      onLoadPdf(url);
    } catch (err) {
      console.error('Upload failed:', err);
      alert(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const handleLegendChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file, 'legend');
    e.target.value = '';
  };

  const handleSiteChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file, 'site');
    e.target.value = '';
  };

  const activePdf = activeView === 'legend' ? legendPdf : sitePdf;

  return (
    <div className="h-12 bg-[#16213e] border-b border-[#1e3a5f] flex items-center justify-center px-6 gap-3 flex-shrink-0">
      <input ref={legendInputRef} type="file" accept=".pdf" onChange={handleLegendChange} className="hidden" />
      <input ref={siteInputRef} type="file" accept=".pdf" onChange={handleSiteChange} className="hidden" />

      {/* Upload buttons */}
      <button
        onClick={() => legendInputRef.current?.click()}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e3a5f] hover:bg-[#254a75] rounded text-sm text-gray-200 cursor-pointer transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        Open Legend
      </button>
      <button
        onClick={() => siteInputRef.current?.click()}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e3a5f] hover:bg-[#254a75] rounded text-sm text-gray-200 cursor-pointer transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
        </svg>
        Open Site Plan
      </button>

      {/* View switcher */}
      <div className="flex bg-[#0f1629] rounded overflow-hidden border border-[#1e3a5f]">
        <button
          onClick={() => { if (legendPdf) { setActiveView('legend'); onLoadPdf(legendPdf.pdfUrl); } }}
          disabled={!legendPdf}
          className={`px-3 py-1 text-xs font-medium transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default ${
            activeView === 'legend' && legendPdf
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Legend
        </button>
        <button
          onClick={() => { if (sitePdf) { setActiveView('site'); onLoadPdf(sitePdf.pdfUrl); } }}
          disabled={!sitePdf}
          className={`px-3 py-1 text-xs font-medium transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default ${
            activeView === 'site' && sitePdf
              ? 'bg-green-600 text-white'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Site
        </button>
      </div>

      {activePdf && (
        <span className="text-xs text-gray-400 truncate max-w-48">
          {activePdf.filename}
        </span>
      )}

      <div className="w-px h-6 bg-[#334155] mx-1" />

      {/* Zoom controls */}
      <button
        onClick={onZoomOut}
        className="p-1.5 rounded hover:bg-[#1e3a5f] text-gray-300 cursor-pointer transition-colors"
        title="Zoom out"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
        </svg>
      </button>
      <span className="text-sm text-gray-300 min-w-[3rem] text-center tabular-nums">
        {Math.round(scale * 100)}%
      </span>
      <button
        onClick={onZoomIn}
        className="p-1.5 rounded hover:bg-[#1e3a5f] text-gray-300 cursor-pointer transition-colors"
        title="Zoom in"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
        </svg>
      </button>
      <button
        onClick={onFitToWidth}
        className="px-2 py-1 rounded hover:bg-[#1e3a5f] text-xs text-gray-300 cursor-pointer transition-colors"
        title="Fit to width"
      >
        Fit
      </button>

      <div className="w-px h-6 bg-[#334155] mx-1" />

      {/* Page navigation */}
      <button
        onClick={() => onGoToPage(pageNum - 1)}
        disabled={pageNum <= 1}
        className="p-1.5 rounded hover:bg-[#1e3a5f] text-gray-300 cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span className="text-sm text-gray-300 tabular-nums">
        Page {pageNum} / {pageCount || 1}
      </span>
      <button
        onClick={() => onGoToPage(pageNum + 1)}
        disabled={pageNum >= pageCount}
        className="p-1.5 rounded hover:bg-[#1e3a5f] text-gray-300 cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      <div className="w-px h-6 bg-[#334155] mx-1" />

      {/* Undo */}
      <button
        onClick={undo}
        disabled={undoStack.length === 0}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-[#1e3a5f] text-gray-300 text-sm cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
        title="Undo last match change (Ctrl+Z)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
        </svg>
        Undo
      </button>
    </div>
  );
}
