import { useEffect, useRef, useState } from 'react';
import { useAppStore, type SymbolTemplate } from '../store/appStore';
import { useProjectStore } from '../store/projectStore';
import { v4 as uuidv4 } from 'uuid';
import { SymbolCard } from './SymbolCard';
import { runSearchStream, exportResults, saveAnnotatedPdf, runAiCount } from '../api/client';
import { PRESET_COLORS } from './SymbolCard';

export function LegendPanel() {
  const {
    sitePdf, activeView, setActiveView, symbols, confidenceThreshold, isSearching, searchProgress, searchProgressPercent,
    manualModeSymbolId, setIsCropMode, isCropMode, removeSymbol, updateSymbolName, updateSymbolColor, toggleSymbolVisibility,
    toggleSelectedForSearch, appendSymbolMatches, clearSymbolMatchesByTemplate, markSearched, setIsSearching, setSearchProgress,
    setSearchProgressPercent, setManualModeSymbolId, markUnsearched, setFocusMatch, pdfLoading, pdfLoadingMessage,
    addCountedSymbol,
  } = useAppStore();

  const activePdf = sitePdf;
  const totalMatches = symbols.reduce((sum, s) => sum + s.matches.length, 0);
  const hasResults = totalMatches > 0;
  const abortRef = useRef<AbortController | null>(null);

  // --- AI count ---
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLog, setAiLog] = useState<string[]>([]);
  const aiAbort = useRef<AbortController | null>(null);
  const log = (t: string) => setAiLog((l) => [...l.slice(-3), t]);
  // the discipline of the open sheet supplies the legend used across its drawings
  const openPdfId = useProjectStore((s) => s.openPdfId);
  const ctx = useProjectStore((s) => {
    const t = s.projects.find((p) => p.id === s.openProjectId)?.takeoffs.find((x) => x.id === s.openTakeoffId);
    const d = t?.disciplines.find((dd) => dd.pdfs.some((f) => f.pdfId === s.openPdfId));
    return d ? { projectId: s.openProjectId!, takeoffId: s.openTakeoffId!, disciplineId: d.id, legendPdfId: d.legendPdfId ?? null, legendItems: d.legendItems ?? [] } : null;
  });
  const legendPdfId = ctx?.legendPdfId ?? null;
  const isLegendSheet = !!ctx && !!openPdfId && ctx.legendPdfId === openPdfId;
  const updateLegendItem = useProjectStore((s) => s.updateLegendItem);
  const removeLegendItem = useProjectStore((s) => s.removeLegendItem);
  const setSymbols = useAppStore((s) => s.setSymbols);

  // Opening a sheet seeds the working set from the discipline's legend: on the legend sheet the
  // entries are shown for editing (no counting); on a drawing they arrive uncounted, so the
  // auto-counter runs each of them against this sheet.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openPdfId || !ctx || seededFor.current === openPdfId) return;
    if (ctx.legendItems.length === 0 && !isLegendSheet) return;
    seededFor.current = openPdfId;
    setSymbols(ctx.legendItems.map((li) => ({
      id: uuidv4(), name: li.name, color: li.color, thumbnail: li.thumbnail, templateId: li.templateId,
      cropRegion: li.cropRegion, visible: true, matches: [], searched: isLegendSheet, selectedForSearch: !isLegendSheet,
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPdfId, isLegendSheet]);

  // edits made while on the legend sheet write through to the discipline's legend
  const syncLegend = (templateId: string, patch: { name?: string; color?: string }) => {
    if (isLegendSheet && ctx) updateLegendItem(ctx.projectId, ctx.takeoffId, ctx.disciplineId, templateId, patch);
  };

  const startAi = () => {
    if (!sitePdf || aiBusy) return;
    const targets = useAppStore.getState().symbols.map((x) => ({ name: x.name, thumbnail: x.thumbnail }));
    setAiBusy(true);
    setAiLog([targets.length ? `Finding your ${targets.length} symbol${targets.length === 1 ? '' : 's'}…` : 'Reading the legend…']);
    aiAbort.current = runAiCount(sitePdf.pdfId, targets, legendPdfId && legendPdfId !== sitePdf.pdfId ? legendPdfId : null, {
      onStatus: (t) => log(t),
      onItem: (it) => {
        const st = useAppStore.getState();
        // a re-count of the same name replaces the earlier item (and frees its colour)
        const old = it.replaces ? st.symbols.find((x) => x.templateId === it.replaces) : st.symbols.find((x) => x.name === it.name && x.matches.length > 0);
        if (old) removeSymbol(old.id);
        const used = useAppStore.getState().symbols.map((x) => x.color);
        const color = PRESET_COLORS.find((c) => !used.includes(c)) || PRESET_COLORS[used.length % PRESET_COLORS.length];
        addCountedSymbol({ name: it.name, color, thumbnail: it.thumbnail, templateId: it.template_id, cropRegion: it.crop_region, matches: it.matches });
      },
      onDone: (summary, cost, n) => { log(`Done - ${n} symbol types (cost $${cost}). ${summary}`); setAiBusy(false); },
      onError: (e) => { log(`AI count failed: ${e.message}`); setAiBusy(false); },
    });
  };
  const stopAi = () => { aiAbort.current?.abort(); setAiBusy(false); log('Stopped.'); };

  const runCount = (toSearch: SymbolTemplate[]) => {
    if (!sitePdf || toSearch.length === 0) return;
    const pages = Array.from({ length: sitePdf.pageCount }, (_, i) => i + 1);
    const totalWork = pages.length * toSearch.length;

    setIsSearching(true);
    setSearchProgress('Counting…');
    setSearchProgressPercent(0);
    for (const s of toSearch) clearSymbolMatchesByTemplate(s.templateId);

    let completed = 0;
    abortRef.current = runSearchStream(
      {
        pdf_id: sitePdf.pdfId,
        symbols: toSearch.map((s) => ({ template_id: s.templateId, symbol_name: s.name })),
        confidence_threshold: confidenceThreshold,
        pages,
      },
      {
        onProgress: (data) => {
          setSearchProgressPercent(Math.round((completed / totalWork) * 100));
          setSearchProgress(`Counting "${data.symbol_name}"…`);
        },
        onSymbolComplete: (data) => {
          completed++;
          if (data.matches.length > 0) appendSymbolMatches(data.template_id, data.matches);
          setSearchProgressPercent(Math.round((completed / totalWork) * 100));
        },
        onDone: () => {
          for (const s of toSearch) markSearched(s.templateId);
          setSearchProgressPercent(100);
          setSearchProgress(null);
          setIsSearching(false);
          abortRef.current = null;
        },
        onError: (err) => {
          console.error('Count failed:', err);
          // mark as counted (0) so we don't retry in a loop; "re-count" on the row tries again
          for (const s of toSearch) markSearched(s.templateId);
          setSearchProgress('Count failed — use re-count on the item to try again');
          setIsSearching(false);
          abortRef.current = null;
        },
      },
    );
  };

  // Auto-count: anything new (or reset via re-count) gets counted as soon as the engine is free.
  useEffect(() => {
    if (isLegendSheet) return; // the legend sheet is for defining symbols, not counting them
    if (isSearching || pdfLoading || !sitePdf) return;
    const pending = symbols.filter((s) => s.selectedForSearch && !s.searched);
    if (pending.length > 0) runCount(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, isSearching, pdfLoading, sitePdf]);

  const resultsPayload = () => symbols.filter((s) => s.matches.length > 0);

  const handleExportCsv = async () => {
    if (!sitePdf) return;
    try {
      await exportResults({
        pdf_id: sitePdf.pdfId,
        results: resultsPayload().map((s) => ({ template_id: s.templateId, symbol_name: s.name, matches: s.matches, total_count: s.matches.length })),
        format: 'csv',
      });
    } catch (err) { console.error('Export failed:', err); alert('Export failed'); }
  };

  const annotationPayload = () => ({
    pdf_id: sitePdf!.pdfId,
    symbols: resultsPayload().map((s) => ({
      name: s.name, color: s.color,
      matches: s.matches.map((m) => ({ page: m.page, x: m.x, y: m.y, width: m.width, height: m.height })),
    })),
  });
  const handleSavePdf = async () => {
    if (!sitePdf || !hasResults) return;
    try { await saveAnnotatedPdf(annotationPayload(), 'download', `annotated_${sitePdf.filename || 'document'}`); }
    catch (err) { console.error('Save failed:', err); alert('Failed to save annotated PDF'); }
  };
  const handlePrint = async () => {
    if (!sitePdf || !hasResults) return;
    try { await saveAnnotatedPdf(annotationPayload(), 'print'); }
    catch (err) { console.error('Print failed:', err); alert('Failed to prepare PDF for printing'); }
  };

  return (
    <div className="w-[348px] bg-[#1f2433] flex flex-col shrink-0 overflow-hidden">
      <div className="p-4 pb-2">
        {pdfLoading ? (
          <div className="rounded-md bg-[#262b3a] border-b-4 border-orange-500 p-5 flex items-center gap-4">
            <svg className="w-8 h-8 animate-spin shrink-0" viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="20" stroke="#1a1f2b" strokeWidth="5"/><path d="M45 25a20 20 0 0 0-20-20" stroke="#22b8f0" strokeWidth="5" strokeLinecap="round"/></svg>
            <div>
              <div className="text-[15px] font-bold text-white">Drawing loading…</div>
              <div className="text-[13px] text-[#aab2c4] mt-1">{pdfLoadingMessage || 'Preparing your sheet.'}</div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsCropMode(!isCropMode)}
            disabled={!activePdf}
            className={`w-full text-left rounded-md bg-[#262b3a] border-b-4 p-5 flex items-start gap-4 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default ${
              isCropMode ? 'border-orange-500 ring-1 ring-orange-500/70' : 'border-orange-500 hover:bg-[#2a3040]'
            }`}
          >
            <svg className="w-11 h-11 shrink-0" viewBox="0 0 44 44">
              <rect x="1" y="1" width="42" height="42" rx="4" fill="#3b2f2a" stroke="#6b4a3a" strokeWidth="1.5"/>
              <rect x="10" y="9" width="20" height="20" rx="2" fill="#f4f1ee"/>
              <text x="20" y="23" fontSize="9" fontWeight="700" textAnchor="middle" fill="#3b2f2a" fontFamily="Inter, sans-serif">AE</text>
              <path d="M31 24v14M24 31h14" stroke="#fff" strokeWidth="1.6"/>
            </svg>
            <div>
              <div className="text-[15px] font-bold text-white">{isLegendSheet ? 'Build the legend' : 'Auto-count items'}</div>
              <div className="text-[13px] text-[#d5dbe6] mt-1 leading-snug">{isLegendSheet ? 'Drag a box over each symbol in the legend. They become the symbol set for every drawing in this discipline.' : 'Drag a box over an item to count it across all your drawings.'}</div>
              <div className="text-[12px] text-[#8a92a6] mt-1.5">{isCropMode ? 'Smart select is on — hold Space and drag to move around.' : 'Smart select is off — click to turn it on.'}</div>
            </div>
          </button>
        )}
      </div>

      <div className="px-4 pb-2" hidden={isLegendSheet}>
        {!aiBusy ? (
          <button
            onClick={startAi}
            disabled={!activePdf || pdfLoading}
            className="w-full text-left rounded-md bg-[#262b3a] border-b-4 border-sky-500 px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-[#2a3040] transition-colors disabled:opacity-40 disabled:cursor-default"
          >
            <span className="text-xl">✨</span>
            <span>
              <span className="block text-[14px] font-bold text-white">AI count <span className="text-[11px] font-semibold text-sky-400 align-middle ml-1">BETA</span></span>
              <span className="block text-[12px] text-[#8a92a6] mt-0.5">{symbols.length ? `AI finds and counts your ${symbols.length} selected symbol${symbols.length === 1 ? '' : 's'} on this sheet.` : (legendPdfId ? 'AI counts the symbol types from this discipline\u2019s legend sheet.' : 'AI counts the symbol types from this sheet\u2019s legend.')}</span>
            </span>
          </button>
        ) : (
          <div className="rounded-md bg-[#262b3a] border-b-4 border-sky-500 px-5 py-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="flex items-center gap-2 text-[14px] font-bold text-white">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="20" stroke="#1a1f2b" strokeWidth="6"/><path d="M45 25a20 20 0 0 0-20-20" stroke="#22b8f0" strokeWidth="6" strokeLinecap="round"/></svg>
                AI counting…
              </span>
              <button onClick={stopAi} className="text-[12px] text-[#aab2c4] hover:text-white cursor-pointer">Stop</button>
            </div>
            {aiLog.slice(-3).map((t, i) => (
              <div key={i} className="text-[11px] text-[#8a92a6] truncate leading-relaxed">{t}</div>
            ))}
          </div>
        )}
        {!aiBusy && aiLog.length > 0 && (
          <p className="text-[11px] text-[#8a92a6] mt-1.5 px-1 leading-snug">{aiLog[aiLog.length - 1]}</p>
        )}
      </div>

      {manualModeSymbolId && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-yellow-500/15 border border-yellow-500/40">
          <p className="text-xs text-yellow-300 text-center">Manual mode: click on the drawing to add an item. Double-click a highlight to remove it.</p>
        </div>
      )}

      {(isSearching || searchProgress) && (
        <div className="mx-4 mb-2">
          {isSearching && (
            <div className="w-full bg-[#181c28] rounded-full h-1.5 overflow-hidden mb-1">
              <div className="bg-orange-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${searchProgressPercent}%` }} />
            </div>
          )}
          <p className="text-xs text-[#aab2c4] truncate">{searchProgress}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto border-t border-[#2c3245]">
        {!pdfLoading && symbols.map((symbol) => (
          <SymbolCard
            key={symbol.id}
            symbol={symbol}
            onToggleVisibility={() => toggleSymbolVisibility(symbol.id)}
            onDelete={() => { removeSymbol(symbol.id); if (isLegendSheet && ctx) removeLegendItem(ctx.projectId, ctx.takeoffId, ctx.disciplineId, symbol.templateId); }}
            onUpdateName={(name) => { updateSymbolName(symbol.id, name); syncLegend(symbol.templateId, { name }); }}
            onUpdateColor={(color) => { updateSymbolColor(symbol.id, color); syncLegend(symbol.templateId, { color }); }}
            onCycleMatch={(matchIndex) => {
              const match = symbol.matches[matchIndex];
              if (match) {
                if (activeView !== 'site' && sitePdf) setActiveView('site');
                setFocusMatch({ page: match.page, x: match.x, y: match.y, width: match.width, height: match.height });
              }
            }}
            onToggleSelectedForSearch={() => toggleSelectedForSearch(symbol.id)}
            onToggleManualMode={() => setManualModeSymbolId(manualModeSymbolId === symbol.id ? null : symbol.id)}
            onMarkUnsearched={() => markUnsearched(symbol.id)}
            isManualMode={manualModeSymbolId === symbol.id}
          />
        ))}
      </div>

      {hasResults && !pdfLoading && (
        <div className="p-4 border-t border-[#2c3245] space-y-2">
          <div className="text-center">
            <span className="text-sm font-semibold text-white">{totalMatches} items found</span>
            <span className="text-xs text-[#aab2c4] ml-1">across {symbols.filter((s) => s.matches.length > 0).length} types</span>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSavePdf} className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Save PDF</button>
            <button onClick={handlePrint} className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Print</button>
            <button onClick={handleExportCsv} className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Export CSV</button>
          </div>
        </div>
      )}
    </div>
  );
}
