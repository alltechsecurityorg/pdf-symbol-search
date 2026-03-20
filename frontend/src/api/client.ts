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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEvent = '';
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
