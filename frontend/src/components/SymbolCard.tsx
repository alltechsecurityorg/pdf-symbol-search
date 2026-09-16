import { useState } from 'react';
import type { SymbolTemplate } from '../store/appStore';

interface SymbolCardProps {
  symbol: SymbolTemplate;
  onToggleVisibility: () => void;
  onDelete: () => void;
  onUpdateName: (name: string) => void;
  onUpdateColor: (color: string) => void;
  onCycleMatch: (matchIndex: number) => void;
  onToggleSelectedForSearch: () => void;
  onToggleManualMode: () => void;
  onMarkUnsearched: () => void;
  onCount: () => void;
  isManualMode: boolean;
}

export const PRESET_COLORS = [
  '#22c55e', '#ef4444', '#3b82f6', '#f97316',
  '#a855f7', '#eab308', '#06b6d4', '#ec4899',
];

const ico = 'w-4 h-4';
const act = 'w-7 h-7 rounded flex items-center justify-center text-[#8a92a6] hover:text-white hover:bg-[#2c3245] cursor-pointer';

export function SymbolCard({
  symbol, onToggleVisibility, onDelete, onUpdateName, onUpdateColor, onCycleMatch, onToggleManualMode, onMarkUnsearched, onCount, isManualMode,
}: SymbolCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(symbol.name);
  const [showColors, setShowColors] = useState(false);
  const [open, setOpen] = useState(true);
  const [idx, setIdx] = useState(0);

  const count = symbol.matches.length;
  const unnamed = /^Unnamed item( \d+)?$/.test(symbol.name);

  const submitName = () => { onUpdateName(editName.trim() || symbol.name); setIsEditing(false); };
  const cycle = () => { if (!count) return; const n = (idx + 1) % count; setIdx(n); onCycleMatch(n); };

  return (
    <div className={`relative group bg-[#1f2433] border-b border-[#2c3245] ${isManualMode ? 'ring-1 ring-inset ring-yellow-500/70' : ''}`}>
      {/* colour bar — click to change */}
      <button onClick={() => setShowColors(!showColors)} title="Change colour" className="absolute left-0 top-0 bottom-0 w-[5px] cursor-pointer" style={{ background: symbol.color }} />
      {showColors && (
        <div className="absolute left-3 top-9 z-30 bg-[#262c3d] border border-[#3a4156] rounded-md p-2 flex flex-wrap gap-1.5 w-[132px] shadow-xl">
          {PRESET_COLORS.map((c) => (
            <button key={c} onClick={() => { onUpdateColor(c); setShowColors(false); }} className="w-6 h-6 rounded cursor-pointer hover:scale-110 transition-transform"
              style={{ background: c, outline: symbol.color === c ? '2px solid #fff' : 'none', outlineOffset: 1 }} />
          ))}
          <input type="color" value={symbol.color} onChange={(e) => onUpdateColor(e.target.value)} className="w-6 h-6 cursor-pointer bg-transparent border-0 p-0" title="Custom colour" />
        </div>
      )}

      {/* header: chevron · name · count · eye (+ hover actions) */}
      <div className="flex items-center gap-1.5 pl-3 pr-2 h-10">
        <button onClick={() => setOpen(!open)} className="w-5 h-5 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer" title={open ? 'Collapse' : 'Expand'}>
          <svg className={`w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        {isEditing ? (
          <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} onBlur={submitName}
            onKeyDown={(e) => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') setIsEditing(false); }} onFocus={(e) => e.target.select()}
            className="flex-1 min-w-0 h-7 bg-[#181c28] border border-orange-500 rounded px-2 text-[14px] text-white outline-none" />
        ) : (
          <button onClick={() => { setEditName(unnamed ? '' : symbol.name); setIsEditing(true); }} title="Click to rename"
            className={`flex-1 min-w-0 text-left text-[15px] truncate cursor-text ${unnamed ? 'text-[#d5dbe6]' : 'text-white'}`}>
            {unnamed ? `<${symbol.name}>` : symbol.name}
          </button>
        )}
        <div className="hidden group-hover:flex items-center">
          <button onClick={onToggleManualMode} className={`${act} ${isManualMode ? 'text-yellow-400' : ''}`} title={isManualMode ? 'Exit manual marking' : 'Manually mark on the drawing'}>
            <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M12 8v8M8 12h8"/></svg>
          </button>
          {symbol.searched && (
            <button onClick={onMarkUnsearched} className={act} title="Reset and count again">
              <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4v5h5M20 20v-5h-5M5.6 9A7 7 0 0 1 18 7.5L20 9M18.4 15A7 7 0 0 1 6 16.5L4 15"/></svg>
            </button>
          )}
          <button onClick={onDelete} className={`${act} hover:text-red-400`} title="Remove item">
            <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
          </button>
        </div>
        {symbol.searched ? (
          <button onClick={cycle} title={count ? 'Jump to next match' : 'None found'} className={`min-w-6 text-right text-[15px] font-bold tabular-nums ${count ? 'text-white cursor-pointer hover:text-orange-400' : 'text-[#6b7280] cursor-default'}`}>
            {count}
          </button>
        ) : symbol.selectedForSearch ? (
          <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 50 50" fill="none" aria-label="Counting"><circle cx="25" cy="25" r="20" stroke="#2c3245" strokeWidth="7"/><path d="M45 25a20 20 0 0 0-20-20" stroke="#f97316" strokeWidth="7" strokeLinecap="round"/></svg>
        ) : (
          <button onClick={onCount} title="Count this symbol on the page" className="shrink-0 text-[11px] font-bold px-2 py-0.5 rounded border border-orange-500/70 text-orange-400 hover:bg-orange-500 hover:text-white cursor-pointer">
            Count
          </button>
        )}
        <button onClick={onToggleVisibility} className={`w-7 h-7 flex items-center justify-center cursor-pointer ${symbol.visible ? 'text-[#d5dbe6] hover:text-white' : 'text-[#6b7280] hover:text-white'}`} title={symbol.visible ? 'Hide highlights' : 'Show highlights'}>
          {symbol.visible
            ? <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            : <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.2 6.2C3.6 8.1 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.8"/></svg>}
        </button>
      </div>

      {/* body: template thumbnail(s) with their counts */}
      {open && (
        <div className="flex gap-2 pl-8 pr-3 pb-3">
          <button onClick={cycle} className="relative w-14 cursor-pointer" title={symbol.searched ? `${count} found` : 'Not counted yet'}>
            <div className="w-14 h-14 bg-white rounded-t-sm flex items-center justify-center p-1">
              <img src={symbol.thumbnail} alt="" className="max-w-full max-h-full object-contain" />
            </div>
            <div className="bg-[#2c3245] text-[11px] text-white text-center rounded-b-sm py-0.5 tabular-nums">{count}</div>
            {!symbol.searched && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-amber-400 text-black text-[10px] font-black flex items-center justify-center shadow" title="Not counted yet">!</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
