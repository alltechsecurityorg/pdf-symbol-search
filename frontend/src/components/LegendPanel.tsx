import { useEffect, useRef, useState } from 'react';
import { useAppStore, type SymbolTemplate, type SymbolMatch } from '../store/appStore';
import { useProjectStore } from '../store/projectStore';
import { useShallow } from 'zustand/react/shallow';
import { v4 as uuidv4 } from 'uuid';
import { SymbolCard } from './SymbolCard';
import { runSearchStream, exportResults, saveAnnotatedPdf, runAiCount, kvGet, kvPutDebounced } from '../api/client';
import { PRESET_COLORS } from './SymbolCard';

export function LegendPanel() {
  const {
    sitePdf, activeView, setActiveView, symbols, confidenceThreshold, isSearching, searchProgress, searchProgressPercent,
    manualModeSymbolId, setIsCropMode, isCropMode, removeSymbol, updateSymbolName, updateSymbolColor, toggleSymbolVisibility,
    toggleSelectedForSearch, setIsSearching, setSearchProgress,
    setSearchProgressPercent, setManualModeSymbolId, markUnsearched, setFocusMatch, pdfLoading, pdfLoadingMessage,
    addCountedSymbol,
    armSymbol,
    armIds,
    appendMatchesById,
    clearMatchesById,
    markSearchedById,
    setVariantTarget,
  } = useAppStore();

  const activePdf = sitePdf;
  const totalMatches = symbols.reduce((sum, s) => sum + s.matches.filter((m) => !m.review).length, 0);
  const totalReview = symbols.reduce((sum, s) => sum + s.matches.filter((m) => m.review).length, 0);
  const hasResults = totalMatches > 0 || totalReview > 0;
  const abortRef = useRef<AbortController | null>(null);

  // --- AI count ---
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLog, setAiLog] = useState<string[]>([]);
  const aiAbort = useRef<AbortController | null>(null);
  const log = (t: string) => setAiLog((l) => [...l.slice(-3), t]);
  // the discipline of the open sheet supplies the legend used across its drawings
  const openPdfId = useProjectStore((s) => s.openPdfId);
  const disc = useProjectStore(useShallow((s) => {
    const t = s.projects.find((p) => p.id === s.openProjectId)?.takeoffs.find((x) => x.id === s.openTakeoffId);
    const d = t?.disciplines.find((dd) => dd.pdfs.some((f) => f.pdfId === s.openPdfId));
    return d ? [s.openProjectId!, s.openTakeoffId!, d] as const : null;
  }));
  const ctx = disc ? { projectId: disc[0], takeoffId: disc[1], disciplineId: disc[2].id, legendPdfId: disc[2].legendPdfId ?? null, legendItems: disc[2].legendItems ?? [] } : null;
  const legendPdfId = ctx?.legendPdfId ?? null;
  const isLegendSheet = !!ctx && !!openPdfId && ctx.legendPdfId === openPdfId;
  const updateLegendItem = useProjectStore((s) => s.updateLegendItem);
  const removeLegendItem = useProjectStore((s) => s.removeLegendItem);
  const setSymbols = useAppStore((s) => s.setSymbols);

  // Opening a sheet restores its saved takeoff (counts included) from the server; without one
  // it seeds from the discipline's legend. Legend items added since the save are appended.
  // The legend sheet itself always mirrors the legend (fresh seed, never saved).
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openPdfId || !ctx || seededFor.current === openPdfId) return;
    seededFor.current = openPdfId;
    const seedOf = (li: (typeof ctx.legendItems)[number]) => ({
      id: uuidv4(), name: li.name, color: li.color, thumbnail: li.thumbnail, templateId: li.templateId,
      cropRegion: li.cropRegion, visible: true, matches: [], searched: false, selectedForSearch: false, queued: false, variants: li.variants ?? [],
    });
    let cancelled = false;
    (async () => {
      const raw = await kvGet(`sheet-${openPdfId}`);
      if (cancelled) return;
      if (raw) {
        try {
          const saved = JSON.parse(raw) as SymbolTemplate[];
          const have = new Set(saved.map((x) => x.templateId));
          const extra = ctx.legendItems.filter((li) => !have.has(li.templateId)).map(seedOf);
          setSymbols([...saved.map((x) => ({ ...x, queued: false })), ...extra]);
          return;
        } catch { /* fall through to seeding */ }
      }
      if (ctx.legendItems.length > 0 || isLegendSheet) setSymbols(ctx.legendItems.map(seedOf));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPdfId, isLegendSheet]);

  // Autosave the working set (items, variants, counts, confirmations) per sheet.
  useEffect(() => {
    if (!openPdfId || seededFor.current !== openPdfId) return;
    if (pdfLoading) return;
    kvPutDebounced(`sheet-${openPdfId}`, JSON.stringify(symbols), 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, openPdfId]);

  // The legend block repeats on every page of this set, so matches inside any legend row's
  // boxed region are legend samples, not counted devices - on every sheet of the discipline.
  const stripLegendSamples = (matches: SymbolMatch[]): SymbolMatch[] => {
    if (!ctx || ctx.legendItems.length === 0) return matches;
    const zones = ctx.legendItems.flatMap((li) => [li.cropRegion, ...(li.variants ?? []).map((v) => v.cropRegion)]);
    return matches.filter((m) => {
      const cx = m.x + m.width / 2, cy = m.y + m.height / 2;
      return !zones.some((z) => cx >= z.x - 2 && cx <= z.x + z.width + 2 && cy >= z.y - 2 && cy <= z.y + z.height + 2);
    });
  };

  // edits made while on the legend sheet write through to the discipline's legend
  const syncLegend = (templateId: string, patch: { name?: string; color?: string }) => {
    if (isLegendSheet && ctx) updateLegendItem(ctx.projectId, ctx.takeoffId, ctx.disciplineId, templateId, patch);
  };

  const startAi = () => {
    if (!sitePdf || aiBusy) return;
    const all = useAppStore.getState().symbols;
    const checked = all.filter((x) => x.selectedForSearch);
    const targets = (checked.length > 0 ? checked : all).map((x) => ({ name: x.name, thumbnail: x.thumbnail, template_id: x.templateId }));
    setAiBusy(true);
    setAiLog([targets.length ? `AI is finding ${checked.length > 0 ? `your ${targets.length} selected` : `all ${targets.length}`} symbol${targets.length === 1 ? '' : 's'}…` : 'Reading the legend…']);
    aiAbort.current = runAiCount(sitePdf.pdfId, targets, legendPdfId && legendPdfId !== sitePdf.pdfId ? legendPdfId : null, {
      onStatus: (t) => log(t),
      onItem: (it) => {
        const st = useAppStore.getState();
        // a re-count of the same name replaces the earlier item (and frees its colour)
        const old = (it.replaces ? st.symbols.find((x) => x.templateId === it.replaces) : undefined) ?? st.symbols.find((x) => x.name.trim().toLowerCase() === it.name.trim().toLowerCase());
        if (old) removeSymbol(old.id);
        const used = useAppStore.getState().symbols.map((x) => x.color);
        const color = PRESET_COLORS.find((c) => !used.includes(c)) || PRESET_COLORS[used.length % PRESET_COLORS.length];
        addCountedSymbol({ name: it.name, color, thumbnail: it.thumbnail, templateId: it.template_id, cropRegion: it.crop_region, matches: stripLegendSamples(it.matches) });
      },
      onDone: (summary, cost, n) => { log(`Done - ${n} symbol types (cost $${cost}). ${summary}`); setAiBusy(false); },
      onError: (e) => { log(`AI count failed: ${e.message}`); setAiBusy(false); },
    });
  };
  const stopAi = () => { aiAbort.current?.abort(); setAiBusy(false); log('Stopped.'); };

  const runCount = (toSearch: SymbolTemplate[]) => {
    if (!sitePdf || toSearch.length === 0) return;
    const pages = Array.from({ length: sitePdf.pageCount }, (_, i) => i + 1);
    // one search entry per template: the item's own plus each variant, all landing on the item
    const entries = toSearch.flatMap((s) => [
      { tpl: s.templateId, symId: s.id, name: s.name },
      ...(s.variants ?? []).map((v) => ({ tpl: v.templateId, symId: s.id, name: s.name })),
    ]);
    const bySymbol: Record<string, string> = Object.fromEntries(entries.map((e) => [e.tpl, e.symId]));
    const totalWork = pages.length * entries.length;

    setIsSearching(true);
    setSearchProgress('Counting…');
    setSearchProgressPercent(0);
    for (const s of toSearch) clearMatchesById(s.id);

    let completed = 0;
    abortRef.current = runSearchStream(
      {
        pdf_id: sitePdf.pdfId,
        symbols: entries.map((e) => ({ template_id: e.tpl, symbol_name: e.name })),
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
          const symId = bySymbol[data.template_id];
          if (symId && data.matches.length > 0) appendMatchesById(symId, stripLegendSamples(data.matches));
          setSearchProgressPercent(Math.round((completed / totalWork) * 100));
        },
        onDone: () => {
          for (const s of toSearch) markSearchedById(s.id);
          setSearchProgressPercent(100);
          setSearchProgress(null);
          setIsSearching(false);
          abortRef.current = null;
        },
        onError: (err) => {
          console.error('Count failed:', err);
          for (const s of toSearch) markSearchedById(s.id);
          setSearchProgress('Count failed — use re-count on the item to try again');
          setIsSearching(false);
          abortRef.current = null;
        },
      },
    );
  };

  // Auto-count: anything new (or reset via re-count) gets counted as soon as the engine is free.
  useEffect(() => {
    if (isSearching || pdfLoading || !sitePdf) return;
    const pending = symbols.filter((s) => s.queued && !s.searched);
    if (pending.length > 0) runCount(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, isSearching, pdfLoading, sitePdf]);

  const resultsPayload = () => symbols.filter((s) => s.matches.length > 0);

  const handleExportCsv = async () => {
    if (!sitePdf) return;
    try {
      await exportResults({
        pdf_id: sitePdf.pdfId,
        results: resultsPayload().map((s) => ({ template_id: s.templateId, symbol_name: s.name, matches: s.matches.filter((m) => !m.review), total_count: s.matches.filter((m) => !m.review).length })),
        format: 'csv',
      });
    } catch (err) { console.error('Export failed:', err); alert('Export failed'); }
  };

  const annotationPayload = () => ({
    pdf_id: sitePdf!.pdfId,
    symbols: resultsPayload().map((s) => ({
      name: s.name, color: s.color,
      matches: s.matches.filter((m) => !m.review).map((m) => ({ page: m.page, x: m.x, y: m.y, width: m.width, height: m.height })),
    })),
  });
  const handleSavePdf = async () => {
    if (!sitePdf || !hasResults) return;
    try { await saveAnnotatedPdf(annotationPayload(), 'download', `annotated_${sitePdf.filename || 'document'}`); }
    catch (err) { console.error('Save failed:', err); alert('Failed to save annotated PDF'); }
  };
  const handleExportYolo = async () => {
    if (!sitePdf || !hasResults) return;
    try {
      const res = await fetch(`/api/export-yolo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(annotationPayload()),
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `training_${sitePdf.pdfId}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { console.error(err); alert('YOLO export failed'); }
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
              <div className="text-[13px] text-[#d5dbe6] mt-1 leading-snug">{isLegendSheet ? 'Drag a box over a whole legend section — each row becomes its own legend symbol, used across every drawing in this discipline.' : 'Drag a box over an item to count it across all your drawings.'}</div>
              <div className="text-[12px] text-[#8a92a6] mt-1.5">{isCropMode ? 'Smart select is on — hold Space and drag to move around.' : 'Smart select is off — click to turn it on.'}</div>
            </div>
          </button>
        )}
      </div>

      {isLegendSheet && symbols.length > 0 && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-[#262b3a] border border-[#3a4156]">
          <p className="text-[12px] text-[#aab2c4] leading-snug">This sheet is the legend, and you can count on it too — the legend's own sample symbols are excluded from counts automatically (on every sheet in this discipline).</p>
        </div>
      )}

      <div className="px-4 pb-2">
        {!aiBusy ? (
          (() => {
            const checked = symbols.filter((s) => s.selectedForSearch).length;
            const uncounted = symbols.filter((s) => !s.searched && !s.queued).length;
            const exactN = checked > 0 ? checked : uncounted;
            const aiTip = symbols.length === 0
              ? (legendPdfId ? 'AI counts the discipline legend\u2019s symbol types.' : 'AI counts the types from this sheet\u2019s legend.')
              : checked > 0 ? `AI finds and counts the ${checked} ticked symbol${checked === 1 ? '' : 's'}.` : `AI finds and counts all ${symbols.length} symbols.`;
            return (
              <div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const st = useAppStore.getState();
                      const ids = (checked > 0 ? st.symbols.filter((s) => s.selectedForSearch) : st.symbols.filter((s) => !s.searched && !s.queued)).map((s) => s.id);
                      armIds(ids);
                    }}
                    disabled={!activePdf || pdfLoading || exactN === 0 || isSearching}
                    title={checked > 0 ? 'Exact-match count of the ticked symbols' : 'Exact-match count of everything not yet counted'}
                    className="flex-1 h-10 rounded-md bg-orange-500 hover:bg-orange-600 text-[14px] font-bold text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
                  >
                    Count {checked > 0 ? `${checked} selected` : (uncounted > 0 ? `page (${uncounted})` : 'page')}
                  </button>
                  <button
                    onClick={startAi}
                    disabled={!activePdf || pdfLoading}
                    title={aiTip}
                    className="flex-1 h-10 rounded-md border border-sky-500/70 text-sky-400 hover:bg-sky-500 hover:text-white text-[14px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
                  >
                    ✨ AI count{checked > 0 ? ` ${checked} selected` : ''}
                  </button>
                </div>
                <p className="text-[11px] text-[#8a92a6] mt-1.5 px-0.5 leading-snug">
                  {checked > 0 ? `Runs only the ${checked} ticked symbol${checked === 1 ? '' : 's'}.` : 'Tick rows to count just a subset.'}
                </p>
              </div>
            );
          })()
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
            onDelete={() => {
              // a legend-backed item re-seeds on every sheet open, so deleting it must
              // remove it from the discipline legend or it just reappears
              const inLegend = !!ctx && ctx.legendItems.some((li) => li.templateId === symbol.templateId);
              if (inLegend) {
                if (!confirm(`Remove "${symbol.name}" from this discipline's legend? It will disappear from every drawing in the discipline.`)) return;
                removeLegendItem(ctx!.projectId, ctx!.takeoffId, ctx!.disciplineId, symbol.templateId);
              }
              removeSymbol(symbol.id);
            }}
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
            onCount={() => armSymbol(symbol.id)}
            onAddVariant={() => { setVariantTarget(symbol.id); setIsCropMode(true); }}
            isManualMode={manualModeSymbolId === symbol.id}
          />
        ))}
      </div>

      {hasResults && !pdfLoading && (
        <div className="p-4 border-t border-[#2c3245] space-y-2">
          <div className="text-center">
            <span className="text-sm font-semibold text-white">{totalMatches} items found</span>
            <span className="text-xs text-[#aab2c4] ml-1">across {symbols.filter((s) => s.matches.length > 0).length} types</span>
            {totalReview > 0 && <span className="block text-xs text-amber-400 mt-0.5">{totalReview} uncertain — dashed on the drawing, click one to confirm, double-click to reject</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleSavePdf} className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Save PDF</button>
            <button onClick={handlePrint} className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Print</button>
            <button onClick={handleExportCsv} className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Export CSV</button>
            <button onClick={handleExportYolo} title="Sheet image + YOLO labels of the confirmed counts, for training a detector" className="flex-1 h-9 rounded-md bg-[#2f3649] hover:bg-[#3a4358] border border-[#3a4156] text-xs font-semibold text-white cursor-pointer">Export YOLO</button>
          </div>
        </div>
      )}
    </div>
  );
}
