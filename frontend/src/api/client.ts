const API_BASE = '/api';

export async function uploadPdf(file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/upload-pdf`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
    throw new Error(err.detail || 'Upload failed');
  }

  return res.json();
}

export function getPdfUrl(pdfId: string) {
  return `${API_BASE}/pdf/${pdfId}`;
}

export function getThumbUrl(pdfId: string) {
  return `${API_BASE}/pdf/${pdfId}/thumbnail`;
}

export async function listPages(pdfId: string): Promise<{ page: number; name: string }[]> {
  const res = await fetch(`${API_BASE}/pdf/${pdfId}/pages`);
  if (!res.ok) throw new Error('Could not read pages');
  return res.json();
}

export async function splitPdf(pdfId: string, pages: number[]) {
  const res = await fetch(`${API_BASE}/split-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_id: pdfId, pages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Split failed' }));
    throw new Error(err.detail || 'Split failed');
  }
  return res.json() as Promise<{ page: number; pdf_id: string; filename: string; page_count: number; page_sizes: { page: number; width_pts: number; height_pts: number }[] }[]>;
}

export async function cropSymbol(params: {
  pdf_id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const res = await fetch(`${API_BASE}/crop-symbol`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Crop failed' }));
    throw new Error(err.detail || 'Crop failed');
  }

  return res.json();
}

export async function runSearch(params: {
  pdf_id: string;
  symbols: { template_id: string; symbol_name: string }[];
  confidence_threshold: number;
  pages?: number[];
}) {
  const res = await fetch(`${API_BASE}/run-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Search failed' }));
    throw new Error(err.detail || 'Search failed');
  }

  return res.json();
}

export interface StreamCallbacks {
  onProgress: (data: {
    current: number;
    total: number;
    symbol_name: string;
    page: number;
  }) => void;
  onSymbolComplete: (data: {
    template_id: string;
    symbol_name: string;
    matches: Array<{
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      confidence: number;
    }>;
    total_count: number;
    page: number;
  }) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export function runSearchStream(
  params: {
    pdf_id: string;
    symbols: { template_id: string; symbol_name: string }[];
    confidence_threshold: number;
    pages?: number[];
  },
  callbacks: StreamCallbacks,
): AbortController {
  const controller = new AbortController();

  fetch(`${API_BASE}/run-search-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Search stream failed' }));
        throw new Error(err.detail || 'Search stream failed');
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (currentEvent === 'progress' && dataStr) {
              callbacks.onProgress(JSON.parse(dataStr));
            } else if (currentEvent === 'symbol_complete' && dataStr) {
              callbacks.onSymbolComplete(JSON.parse(dataStr));
            } else if (currentEvent === 'done') {
              callbacks.onDone();
            }
            currentEvent = '';
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        callbacks.onError(err);
      }
    });

  return controller;
}

export async function saveAnnotatedPdf(
  params: {
    pdf_id: string;
    symbols: { name: string; color: string; matches: { page: number; x: number; y: number; width: number; height: number }[] }[];
  },
  mode: 'download' | 'print' = 'download',
  filename = 'annotated.pdf',
) {
  const res = await fetch(`${API_BASE}/save-annotated`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Save failed' }));
    throw new Error(err.detail || 'Save failed');
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  if (mode === 'print') {
    // Open annotated PDF in new tab for printing
    const printWindow = window.open(url, '_blank');
    if (printWindow) {
      printWindow.addEventListener('load', () => {
        printWindow.print();
      });
    }
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  // Clean up after a delay to allow download/print to start
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function exportResults(params: {
  pdf_id: string;
  results: any[];
  format: string;
}) {
  const res = await fetch(`${API_BASE}/export-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    throw new Error('Export failed');
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `symbol_results.${params.format}`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Deep Zoom tiles ---
export interface TilesStatus { ready: boolean; nobg: boolean | null; complete: boolean; running: boolean; progress: number; error: string | null;
  meta: { width_pt: number; height_pt: number; scale: number; width_px: number; height_px: number } | null }
export async function prepareTiles(pdfId: string): Promise<TilesStatus> {
  const res = await fetch(`${API_BASE}/tiles/${pdfId}/prepare`, { method: 'POST' });
  if (!res.ok) throw new Error('Could not prepare drawing');
  return res.json();
}
export async function getTilesStatus(pdfId: string): Promise<TilesStatus> {
  const res = await fetch(`${API_BASE}/tiles/${pdfId}/status`);
  if (!res.ok) throw new Error('Could not read drawing status');
  return res.json();
}
export function tileSourceUrl(pdfId: string, variant: 'base' | 'nobg') {
  return `${API_BASE}/tilefiles/${pdfId}/${variant}/image.dzi`;
}

// --- AI count (agentic takeoff) ---
export interface AiItem {
  template_id: string; name: string; thumbnail: string; replaces?: string | null;
  crop_region: { page: number; x: number; y: number; width: number; height: number };
  matches: { page: number; x: number; y: number; width: number; height: number; confidence: number }[];
}
export function runAiCount(
  pdfId: string,
  targets: { name: string; thumbnail: string }[],
  legendPdfId: string | null,
  cb: { onStatus: (text: string) => void; onItem: (item: AiItem) => void;
        onDone: (summary: string, cost: number, items: number) => void; onError: (err: Error) => void },
): AbortController {
  const controller = new AbortController();
  fetch(`${API_BASE}/ai-count/${pdfId}`, {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets, legend_pdf_id: legendPdfId }),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { detail?: string }).detail || 'AI count failed');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          const ev = JSON.parse(raw);
          if (ev.type === 'status') cb.onStatus(ev.text);
          else if (ev.type === 'item') cb.onItem(ev);
          else if (ev.type === 'done') cb.onDone(ev.summary, ev.cost, ev.items);
          else if (ev.type === 'error') cb.onError(new Error(ev.detail));
        }
      }
    })
    .catch((err) => { if (err.name !== 'AbortError') cb.onError(err); });
  return controller;
}

export async function getWords(pdfId: string, x0: number, y0: number, x1: number, y1: number): Promise<string[]> {
  const res = await fetch(`${API_BASE}/pdf/${pdfId}/words?x0=${x0}&y0=${y0}&x1=${x1}&y1=${y1}`);
  if (!res.ok) return [];
  const d = await res.json() as { words: { text: string }[] };
  return d.words.map((w) => w.text);
}
