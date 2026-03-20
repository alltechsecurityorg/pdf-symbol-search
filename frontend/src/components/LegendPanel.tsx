import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { SymbolCard } from './SymbolCard';
import { runSearchStream, exportResults, saveAnnotatedPdf } from '../api/client';

export function LegendPanel() {
  const {
    legendPdf,
    sitePdf,
    activeView,
    setActiveView,
    symbols,
    confidenceThreshold,
    isSearching,
    searchProgress,
    searchScope,
    searchProgressPercent,
    panelCollapsed,
    manualModeSymbolId,
    currentPage,
    setConfidenceThreshold,
    setIsCropMode,
    isCropMode,
    removeSymbol,
    updateSymbolName,
    updateSymbolColor,
    toggleSymbolVisibility,
    toggleSelectedForSearch,
    appendSymbolMatches,
    clearSymbolMatchesByTemplate,
    markSearched,
    setIsSearching,
    setSearchProgress,
    setSearchScope,
    setSearchProgressPercent,
    setPanelCollapsed,
    setManualModeSymbolId,
    markUnsearched,
    setFocusMatch,
  } = useAppStore();

  const activePdf = activeView === 'legend' ? legendPdf : sitePdf;
  const totalMatches = symbols.reduce((sum, s) => sum + s.matches.length, 0);
  const hasResults = totalMatches > 0;

  const symbolsToSearch = symbols.filter((s) => s.selectedForSearch);
  const abortRef = useRef<AbortController | null>(null);

  const handleRunSearch = () => {
    if (!sitePdf || symbolsToSearch.length === 0) return;

    const pages =
      searchScope === 'current'
        ? [currentPage]
        : Array.from({ length: sitePdf.pageCount }, (_, i) => i + 1);

    const totalWork = pages.length * symbolsToSearch.length;

    setIsSearching(true);
    setSearchProgress('Starting search...');
    setSearchProgressPercent(0);

    // Clear existing matches for symbols being searched
    for (const s of symbolsToSearch) {
      clearSymbolMatchesByTemplate(s.templateId);
    }

    let completedWork = 0;
    let totalMatchCount = 0;

    abortRef.current = runSearchStream(
      {
        pdf_id: sitePdf.pdfId,
        symbols: symbolsToSearch.map((s) => ({
          template_id: s.templateId,
          symbol_name: s.name,
        })),
        confidence_threshold: confidenceThreshold,
        pages,
      },
      {
        onProgress: (data) => {
          const percent = Math.round((completedWork / totalWork) * 100);
          setSearchProgressPercent(percent);
          setSearchProgress(
            `Searching "${data.symbol_name}" on page ${data.page}...`
          );
        },
        onSymbolComplete: (data) => {
          completedWork++;
          totalMatchCount += data.matches.length;
          if (data.matches.length > 0) {
            appendSymbolMatches(data.template_id, data.matches);
          }
          const percent = Math.round((completedWork / totalWork) * 100);
          setSearchProgressPercent(percent);
        },
        onDone: () => {
          for (const s of symbolsToSearch) {
            markSearched(s.templateId);
          }
          setSearchProgressPercent(100);
          setSearchProgress(`Found ${totalMatchCount} matches`);
          setIsSearching(false);
          abortRef.current = null;
        },
        onError: (err) => {
          console.error('Search stream failed:', err);
          setSearchProgress('Search failed');
          setIsSearching(false);
          abortRef.current = null;
        },
      },
    );
  };

  const handleExportCsv = async () => {
    if (!sitePdf) return;

    const results = symbols
      .filter((s) => s.matches.length > 0)
      .map((s) => ({
        template_id: s.templateId,
        symbol_name: s.name,
        matches: s.matches,
        total_count: s.matches.length,
      }));

    try {
      await exportResults({
        pdf_id: sitePdf.pdfId,
        results,
        format: 'csv',
      });
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed');
    }
  };

  const getAnnotationPayload = () => ({
    pdf_id: sitePdf!.pdfId,
    symbols: symbols
      .filter((s) => s.matches.length > 0)
      .map((s) => ({
        name: s.name,
        color: s.color,
        matches: s.matches.map((m) => ({
          page: m.page,
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
        })),
      })),
  });

  const handleSavePdf = async () => {
    if (!sitePdf || !hasResults) return;
    try {
      await saveAnnotatedPdf(getAnnotationPayload(), 'download', `annotated_${sitePdf.filename || 'document'}`);
    } catch (err) {
      console.error('Save failed:', err);
      alert('Failed to save annotated PDF');
    }
  };

  const handlePrint = async () => {
    if (!sitePdf || !hasResults) return;
    try {
      await saveAnnotatedPdf(getAnnotationPayload(), 'print');
    } catch (err) {
      console.error('Print failed:', err);
      alert('Failed to prepare PDF for printing');
    }
  };

  const handleToggleManualMode = (symbolId: string) => {
    setManualModeSymbolId(manualModeSymbolId === symbolId ? null : symbolId);
  };

  if (panelCollapsed) {
    return (
      <div className="w-10 bg-[#16213e] border-l border-[#1e3a5f] flex flex-col items-center pt-3">
        <button
          onClick={() => setPanelCollapsed(false)}
          className="p-1.5 rounded hover:bg-[#1e3a5f] text-gray-400 cursor-pointer"
          title="Expand panel"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="w-80 bg-[#16213e] border-l border-[#1e3a5f] flex flex-col flex-shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-[#1e3a5f] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Symbol Legend</h2>
        <button
          onClick={() => setPanelCollapsed(true)}
          className="p-1 rounded hover:bg-[#1e3a5f] text-gray-400 cursor-pointer"
          title="Collapse panel"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Add Symbol button */}
      <div className="p-3 border-b border-[#1e3a5f]">
        <button
          onClick={() => setIsCropMode(!isCropMode)}
          disabled={!activePdf}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors ${
            isCropMode
              ? 'bg-blue-600 text-white'
              : 'bg-[#1e3a5f] hover:bg-[#254a75] text-gray-200'
          } disabled:opacity-30 disabled:cursor-default`}
        >
          {isCropMode ? (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Cancel Selection
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Symbol
            </>
          )}
        </button>
        {isCropMode && (
          <p className="text-xs text-blue-400 mt-2 text-center">
            Draw a rectangle around a symbol on the PDF
          </p>
        )}
      </div>

      {/* Manual mode indicator */}
      {manualModeSymbolId && (
        <div className="px-3 py-2 bg-yellow-900/30 border-b border-yellow-600/40">
          <p className="text-xs text-yellow-400 text-center">
            Manual mode: Click on the PDF to add matches. Double-click any highlight to remove it.
          </p>
        </div>
      )}

      {/* Symbol list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {symbols.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            <p>No symbols added yet.</p>
            <p className="mt-1">Click "Add Symbol" to begin.</p>
          </div>
        ) : (
          symbols.map((symbol) => (
            <SymbolCard
              key={symbol.id}
              symbol={symbol}
              onToggleVisibility={() => toggleSymbolVisibility(symbol.id)}
              onDelete={() => removeSymbol(symbol.id)}
              onUpdateName={(name) => updateSymbolName(symbol.id, name)}
              onUpdateColor={(color) => updateSymbolColor(symbol.id, color)}
              onCycleMatch={(matchIndex) => {
                const match = symbol.matches[matchIndex];
                if (match) {
                  if (activeView !== 'site' && sitePdf) {
                    setActiveView('site');
                  }
                  setFocusMatch({
                    page: match.page,
                    x: match.x,
                    y: match.y,
                    width: match.width,
                    height: match.height,
                  });
                }
              }}
              onToggleSelectedForSearch={() => toggleSelectedForSearch(symbol.id)}
              onToggleManualMode={() => handleToggleManualMode(symbol.id)}
              onMarkUnsearched={() => markUnsearched(symbol.id)}
              isManualMode={manualModeSymbolId === symbol.id}
            />
          ))
        )}
      </div>

      {/* Footer controls */}
      <div className="p-3 border-t border-[#1e3a5f] space-y-3">
        {/* Confidence threshold */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-400">Confidence Threshold</label>
            <span className="text-xs text-gray-300 tabular-nums font-mono">
              {Math.round(confidenceThreshold * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.3}
            max={1.0}
            step={0.05}
            value={confidenceThreshold}
            onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
          />
        </div>

        {/* Page scope selector */}
        {sitePdf && sitePdf.pageCount > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Search:</label>
            <div className="flex bg-[#0f1629] rounded overflow-hidden border border-[#1e3a5f] flex-1">
              <button
                onClick={() => setSearchScope('all')}
                className={`flex-1 px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                  searchScope === 'all'
                    ? 'bg-green-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                All Pages ({sitePdf.pageCount})
              </button>
              <button
                onClick={() => setSearchScope('current')}
                className={`flex-1 px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                  searchScope === 'current'
                    ? 'bg-green-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Current Page
              </button>
            </div>
          </div>
        )}

        {/* Run Search */}
        <button
          onClick={handleRunSearch}
          disabled={!sitePdf || symbolsToSearch.length === 0 || isSearching}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 rounded-lg text-sm text-white font-medium cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
          title={!sitePdf ? 'Load a site plan to search' : ''}
        >
          {isSearching ? (
            <>
              <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Searching...
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Search{symbolsToSearch.length < symbols.length ? ` (${symbolsToSearch.length} selected)` : ''}
            </>
          )}
        </button>

        {!sitePdf && symbols.length > 0 && (
          <p className="text-xs text-center text-yellow-400/70">Load a site plan to search</p>
        )}

        {/* Progress / Results */}
        {(isSearching || searchProgress) && (
          <div className="space-y-1">
            {isSearching && (
              <div className="w-full bg-[#0f1629] rounded-full h-2 overflow-hidden">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${searchProgressPercent}%` }}
                />
              </div>
            )}
            <p className="text-xs text-center text-gray-400">
              {isSearching
                ? `${searchProgressPercent}% — ${searchProgress}`
                : searchProgress}
            </p>
          </div>
        )}

        {hasResults && (
          <div className="space-y-2">
            <div className="text-center">
              <span className="text-sm font-medium text-gray-200">
                {totalMatches} symbols found
              </span>
              <span className="text-xs text-gray-400 ml-1">
                across {symbols.filter((s) => s.matches.length > 0).length} types
              </span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSavePdf}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white cursor-pointer transition-colors font-medium"
                title="Save PDF with highlights"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Save PDF
              </button>
              <button
                onClick={handlePrint}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#1e3a5f] hover:bg-[#254a75] rounded text-xs text-gray-300 cursor-pointer transition-colors"
                title="Print with highlights"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Print
              </button>
            </div>

            <button
              onClick={handleExportCsv}
              className="w-full px-3 py-1.5 bg-[#1e3a5f] hover:bg-[#254a75] rounded text-xs text-gray-300 cursor-pointer transition-colors"
            >
              Export CSV
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
