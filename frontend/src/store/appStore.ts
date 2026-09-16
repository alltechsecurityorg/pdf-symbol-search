import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export interface SymbolMatch {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  manual?: boolean;
}

export interface SymbolTemplate {
  id: string;
  name: string;
  color: string;
  thumbnail: string;
  cropRegion: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  templateId: string;
  visible: boolean;
  matches: SymbolMatch[];
  searched: boolean;
  selectedForSearch: boolean;
}

export interface PdfInfo {
  pdfId: string;
  pdfUrl: string;
  filename: string;
  pageCount: number;
  pageSizes: { page: number; width_pts: number; height_pts: number }[];
}

type UndoAction =
  | { type: 'add_manual'; symbolId: string; matchIndex: number }
  | { type: 'remove'; symbolId: string; match: SymbolMatch; matchIndex: number };

interface AppState {
  legendPdf: PdfInfo | null;
  sitePdf: PdfInfo | null;
  activeView: 'legend' | 'site';
  symbols: SymbolTemplate[];
  confidenceThreshold: number;
  isSearching: boolean;
  searchProgress: string | null;
  isCropMode: boolean;
  manualModeSymbolId: string | null;
  currentPage: number;
  zoomLevel: number;
  panelCollapsed: boolean;
  searchScope: 'all' | 'current';
  searchProgressPercent: number;
  undoStack: UndoAction[];
  focusMatch: { page: number; x: number; y: number; width: number; height: number; _seq: number } | null;
  pdfLoading: boolean;
  pdfLoadingMessage: string;
  hideBackground: boolean;
  drawingScale: number;

  setLegendPdf: (info: PdfInfo) => void;
  setSitePdf: (info: PdfInfo) => void;
  setActiveView: (view: 'legend' | 'site') => void;
  addSymbol: (symbol: Omit<SymbolTemplate, 'id' | 'visible' | 'matches' | 'searched' | 'selectedForSearch'>) => void;
  addCountedSymbol: (symbol: Omit<SymbolTemplate, 'id' | 'visible' | 'searched' | 'selectedForSearch'>) => void;
  removeSymbol: (id: string) => void;
  updateSymbolName: (id: string, name: string) => void;
  updateSymbolColor: (id: string, color: string) => void;
  toggleSymbolVisibility: (id: string) => void;
  toggleSelectedForSearch: (id: string) => void;
  setSymbolMatches: (templateId: string, matches: SymbolMatch[]) => void;
  appendSymbolMatches: (templateId: string, matches: SymbolMatch[]) => void;
  clearSymbolMatchesByTemplate: (templateId: string) => void;
  addManualMatch: (symbolId: string, match: SymbolMatch) => void;
  removeMatch: (symbolId: string, matchIndex: number) => void;
  undo: () => void;
  markSearched: (templateId: string) => void;
  markUnsearched: (id: string) => void;
  clearAllMatches: () => void;
  setConfidenceThreshold: (value: number) => void;
  setIsSearching: (value: boolean) => void;
  setSearchProgress: (value: string | null) => void;
  setSearchScope: (scope: 'all' | 'current') => void;
  setSearchProgressPercent: (percent: number) => void;
  setIsCropMode: (value: boolean) => void;
  setManualModeSymbolId: (id: string | null) => void;
  setCurrentPage: (page: number) => void;
  setZoomLevel: (zoom: number) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  setFocusMatch: (match: { page: number; x: number; y: number; width: number; height: number } | null) => void;
  setPdfLoading: (v: boolean) => void;
  setPdfLoadingMessage: (v: string) => void;
  setHideBackground: (v: boolean) => void;
  setDrawingScale: (v: number) => void;
  reset: () => void;
}

const initialState = {
  legendPdf: null as PdfInfo | null,
  sitePdf: null as PdfInfo | null,
  activeView: 'legend' as 'legend' | 'site',
  symbols: [] as SymbolTemplate[],
  confidenceThreshold: 0.60,
  isSearching: false,
  searchProgress: null as string | null,
  searchScope: 'all' as 'all' | 'current',
  searchProgressPercent: 0,
  isCropMode: false,
  manualModeSymbolId: null as string | null,
  currentPage: 1,
  zoomLevel: 1.0,
  panelCollapsed: false,
  undoStack: [] as UndoAction[],
  focusMatch: null as AppState['focusMatch'],
  pdfLoading: false,
  pdfLoadingMessage: '',
  hideBackground: false,
  drawingScale: 0,
};

export const useAppStore = create<AppState>((set) => ({
  ...initialState,

  setLegendPdf: (info) => set({ legendPdf: info, activeView: 'legend' }),
  setSitePdf: (info) => set({ sitePdf: info, activeView: 'site', pdfLoading: true }),
  setActiveView: (view) => set({ activeView: view }),

  addSymbol: (symbol) =>
    set((state) => ({
      symbols: [
        ...state.symbols,
        { ...symbol, id: uuidv4(), visible: true, matches: [], searched: false, selectedForSearch: true },
      ],
    })),

  // AI-counted items arrive with their matches already found - never re-queued for auto-count
  addCountedSymbol: (symbol) =>
    set((state) => ({
      symbols: [
        ...state.symbols,
        { ...symbol, id: uuidv4(), visible: true, searched: true, selectedForSearch: false },
      ],
    })),

  removeSymbol: (id) =>
    set((state) => ({
      symbols: state.symbols.filter((s) => s.id !== id),
      manualModeSymbolId: state.manualModeSymbolId === id ? null : state.manualModeSymbolId,
    })),

  updateSymbolName: (id, name) =>
    set((state) => ({
      symbols: state.symbols.map((s) => (s.id === id ? { ...s, name } : s)),
    })),

  updateSymbolColor: (id, color) =>
    set((state) => ({
      symbols: state.symbols.map((s) => (s.id === id ? { ...s, color } : s)),
    })),

  toggleSymbolVisibility: (id) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.id === id ? { ...s, visible: !s.visible } : s
      ),
    })),

  toggleSelectedForSearch: (id) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.id === id ? { ...s, selectedForSearch: !s.selectedForSearch } : s
      ),
    })),

  setSymbolMatches: (templateId, matches) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.templateId === templateId ? { ...s, matches, searched: true, selectedForSearch: false } : s
      ),
    })),

  appendSymbolMatches: (templateId, matches) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.templateId === templateId
          ? { ...s, matches: [...s.matches, ...matches] }
          : s
      ),
    })),

  clearSymbolMatchesByTemplate: (templateId) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.templateId === templateId ? { ...s, matches: [], searched: false } : s
      ),
    })),

  addManualMatch: (symbolId, match) =>
    set((state) => {
      const symbol = state.symbols.find((s) => s.id === symbolId);
      const matchIndex = symbol ? symbol.matches.length : 0;
      return {
        symbols: state.symbols.map((s) =>
          s.id === symbolId ? { ...s, matches: [...s.matches, match] } : s
        ),
        undoStack: [...state.undoStack, { type: 'add_manual', symbolId, matchIndex }],
      };
    }),

  removeMatch: (symbolId, matchIndex) =>
    set((state) => {
      const symbol = state.symbols.find((s) => s.id === symbolId);
      const removedMatch = symbol?.matches[matchIndex];
      return {
        symbols: state.symbols.map((s) =>
          s.id === symbolId
            ? { ...s, matches: s.matches.filter((_, i) => i !== matchIndex) }
            : s
        ),
        undoStack: removedMatch
          ? [...state.undoStack, { type: 'remove', symbolId, match: removedMatch, matchIndex }]
          : state.undoStack,
      };
    }),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const action = state.undoStack[state.undoStack.length - 1];
      const newStack = state.undoStack.slice(0, -1);

      if (action.type === 'add_manual') {
        return {
          symbols: state.symbols.map((s) =>
            s.id === action.symbolId
              ? { ...s, matches: s.matches.filter((_, i) => i !== action.matchIndex) }
              : s
          ),
          undoStack: newStack,
        };
      } else if (action.type === 'remove') {
        return {
          symbols: state.symbols.map((s) => {
            if (s.id !== action.symbolId) return s;
            const newMatches = [...s.matches];
            newMatches.splice(action.matchIndex, 0, action.match);
            return { ...s, matches: newMatches };
          }),
          undoStack: newStack,
        };
      }
      return state;
    }),

  markSearched: (templateId) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.templateId === templateId ? { ...s, searched: true, selectedForSearch: false } : s
      ),
    })),

  markUnsearched: (id) =>
    set((state) => ({
      symbols: state.symbols.map((s) =>
        s.id === id ? { ...s, searched: false, selectedForSearch: true, matches: [] } : s
      ),
    })),

  clearAllMatches: () =>
    set((state) => ({
      symbols: state.symbols.map((s) => ({ ...s, matches: [], searched: false, selectedForSearch: true })),
    })),

  setConfidenceThreshold: (value) => set({ confidenceThreshold: value }),
  setIsSearching: (value) => set({ isSearching: value }),
  setSearchProgress: (value) => set({ searchProgress: value }),
  setSearchScope: (scope) => set({ searchScope: scope }),
  setSearchProgressPercent: (percent) => set({ searchProgressPercent: percent }),
  setIsCropMode: (value) => set({ isCropMode: value }),
  setManualModeSymbolId: (id) => set({ manualModeSymbolId: id }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setZoomLevel: (zoom) => set({ zoomLevel: zoom }),
  setPanelCollapsed: (collapsed) => set({ panelCollapsed: collapsed }),
  setFocusMatch: (match) => set((state) => ({
    focusMatch: match ? { ...match, _seq: (state.focusMatch?._seq ?? 0) + 1 } : null,
  })),

  setPdfLoading: (v) => set({ pdfLoading: v }),
  setPdfLoadingMessage: (v) => set({ pdfLoadingMessage: v }),
  setHideBackground: (v) => set({ hideBackground: v }),
  setDrawingScale: (v) => set({ drawingScale: v }),

  reset: () => set(initialState),
}));
