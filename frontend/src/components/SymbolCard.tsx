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
  isManualMode: boolean;
}

const PRESET_COLORS = [
  '#22c55e', '#ef4444', '#3b82f6', '#f97316',
  '#a855f7', '#eab308', '#06b6d4', '#ec4899',
];

export function SymbolCard({
  symbol,
  onToggleVisibility,
  onDelete,
  onUpdateName,
  onUpdateColor,
  onCycleMatch,
  onToggleSelectedForSearch,
  onToggleManualMode,
  onMarkUnsearched,
  isManualMode,
}: SymbolCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(symbol.name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  const handleNameSubmit = () => {
    onUpdateName(editName);
    setIsEditing(false);
  };

  const handleCycleMatch = () => {
    if (symbol.matches.length === 0) return;
    const nextIdx = (currentMatchIdx + 1) % symbol.matches.length;
    setCurrentMatchIdx(nextIdx);
    onCycleMatch(nextIdx);
  };

  return (
    <div
      className={`bg-[#0f1629] rounded-lg p-3 border ${
        isManualMode ? 'border-yellow-500' : 'border-[#1e3a5f]'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* Search selection checkbox */}
        <div className="flex-shrink-0 pt-2.5">
          <input
            type="checkbox"
            checked={symbol.selectedForSearch}
            onChange={onToggleSelectedForSearch}
            className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
            title={symbol.searched ? 'Select to re-search' : 'Include in search'}
          />
        </div>

        {/* Color swatch */}
        <div className="relative">
          <button
            onClick={() => setShowColorPicker(!showColorPicker)}
            className="w-10 h-10 rounded border-2 border-[#334155] cursor-pointer flex-shrink-0"
            style={{ backgroundColor: symbol.color }}
          />
          {showColorPicker && (
            <div className="absolute top-12 left-0 z-50 bg-[#16213e] border border-[#334155] rounded-lg p-2 flex flex-wrap gap-1.5 w-32 shadow-xl">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    onUpdateColor(c);
                    setShowColorPicker(false);
                  }}
                  className="w-6 h-6 rounded border-2 cursor-pointer hover:scale-110 transition-transform"
                  style={{
                    backgroundColor: c,
                    borderColor: symbol.color === c ? '#fff' : 'transparent',
                  }}
                />
              ))}
              <input
                type="color"
                value={symbol.color}
                onChange={(e) => onUpdateColor(e.target.value)}
                className="w-6 h-6 cursor-pointer bg-transparent border-0"
              />
            </div>
          )}
        </div>

        {/* Thumbnail */}
        <img
          src={symbol.thumbnail}
          alt={symbol.name}
          className="w-10 h-10 border border-[#334155] rounded bg-white object-contain flex-shrink-0"
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
              autoFocus
              className="w-full bg-[#1a2744] border border-[#3b82f6] rounded px-2 py-0.5 text-sm text-white outline-none"
            />
          ) : (
            <div
              onClick={() => {
                setIsEditing(true);
                setEditName(symbol.name);
              }}
              className="text-sm font-medium text-gray-200 truncate cursor-pointer hover:text-white"
              title="Click to rename"
            >
              {symbol.name}
            </div>
          )}

          <div className="flex items-center gap-1.5 mt-0.5">
            {symbol.matches.length > 0 && (
              <button
                onClick={handleCycleMatch}
                className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer flex items-center gap-1"
                title="Find next match"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {currentMatchIdx + 1}/{symbol.matches.length}
              </button>
            )}
            {symbol.searched && (
              <button
                onClick={onMarkUnsearched}
                className="text-xs text-gray-500 hover:text-yellow-400 cursor-pointer"
                title="Reset to re-search this symbol"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Manual mode toggle */}
          <button
            onClick={onToggleManualMode}
            className={`p-1 rounded cursor-pointer transition-colors ${
              isManualMode
                ? 'bg-yellow-600/30 text-yellow-400'
                : 'hover:bg-[#1e3a5f] text-gray-400 hover:text-white'
            }`}
            title={isManualMode ? 'Exit manual marking' : 'Manual marking mode'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button
            onClick={onToggleVisibility}
            className="p-1 rounded hover:bg-[#1e3a5f] text-gray-400 hover:text-white cursor-pointer transition-colors"
            title={symbol.visible ? 'Hide highlights' : 'Show highlights'}
          >
            {symbol.visible ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            )}
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-red-900/50 text-gray-400 hover:text-red-400 cursor-pointer transition-colors"
            title="Remove symbol"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
