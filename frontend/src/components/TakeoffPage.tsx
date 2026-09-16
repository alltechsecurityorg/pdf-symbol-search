import { useMemo, useRef, useState } from 'react';
import { useProjectStore, type Discipline, type TakeoffPdf } from '../store/projectStore';
import { useAppStore } from '../store/appStore';
import { uploadPdf, getPdfUrl, getThumbUrl, listPages, splitPdf, prepareTiles } from '../api/client';
import { Modal, Menu, field, btnDark, btnOrange, menuItem, IconDots, IconTrash } from './ui';

const IconFolderOpen = () => (<svg className="w-[18px] h-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H6.5a2 2 0 0 0-1.9 1.4L3 17V7z"/><path d="M3 17l1.6-5.6A2 2 0 0 1 6.5 10H22l-2 7a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1.4z"/></svg>);
const IconPdf = ({ className = 'w-11 h-11' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 4h16l10 10v24a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M28 4v10h10"/>
    <text x="17" y="37" fontSize="11" fontWeight="700" fill="currentColor" stroke="none" fontFamily="Inter, sans-serif">PDF</text>
  </svg>
);
const IconFile = () => (<svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6"/></svg>);
const Spinner = () => (<svg className="w-24 h-24 animate-spin" viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="20" stroke="#1a1f2b" strokeWidth="4"/><path d="M45 25a20 20 0 0 0-20-20" stroke="#22b8f0" strokeWidth="4" strokeLinecap="round"/></svg>);

const TILE = 'w-[300px] h-[214px]';

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) onFiles(files);
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      onClick={() => input.current?.click()}
      className={`${TILE} border-2 border-dashed rounded-sm flex flex-col items-center justify-center text-center px-6 transition-colors cursor-pointer hover:border-[#6b7590] hover:bg-[#232838]
        ${over ? 'border-orange-500 bg-[#262b3a]' : 'border-[#4b5364]'}`}
    >
      <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      <div className="text-[#8a92a6] mb-2"><IconPdf /></div>
      <p className="text-[13px] text-[#8a92a6] leading-snug"><span className="text-sky-400">Upload</span> PDFs from your computer (or drag &amp; drop).</p>
    </div>
  );
}

interface Pending { key: string; disciplineId: string; filename: string }
interface ImportState { discipline: Discipline; pdfId: string; filename: string; pages: { page: number; name: string }[] }

function ImportPagesModal({ st, onClose, onImport }: { st: ImportState; onClose: () => void; onImport: (pages: number[], legendPage: number | null) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [legendPage, setLegendPage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? st.pages.filter((p) => p.name.toLowerCase().includes(s) || String(p.page) === s) : st.pages;
  }, [q, st.pages]);
  const toggle = (p: number) => setSel((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const go = async () => {
    setBusy(true);
    const pages = new Set(sel);
    if (legendPage != null) pages.add(legendPage); // the legend page always imports
    try { await onImport([...pages].sort((a, b) => a - b), legendPage); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="relative w-[660px] bg-[#1f2433] rounded-lg shadow-2xl px-5 pt-5 pb-5" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-3 text-[#aab2c4] hover:text-white text-2xl leading-none cursor-pointer">&times;</button>
        <h2 className="text-[19px] font-semibold text-white mb-5">Import pages into discipline <span className="text-orange-400">{st.discipline.name}</span></h2>

        <p className="text-[15px] text-white mb-1.5">Select pages to import from:</p>
        <p className="flex items-center gap-2 text-[15px] text-[#8a92a6] mb-8"><IconFile />{st.filename}</p>

        <label className="block text-[15px] font-bold text-white mb-2">Search page names</label>
        <div className="flex items-center gap-3 mb-4">
          <input autoFocus className={field} value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={() => setSel(new Set(st.pages.map((p) => p.page)))} className={`${btnDark} whitespace-nowrap`}>Select all</button>
          <button onClick={() => setSel(new Set())} disabled={sel.size === 0} className={`${btnDark} whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed`}>Deselect all</button>
        </div>

        <div className="max-h-[220px] overflow-y-auto pr-1 -mr-1">
          {shown.map((p) => (
            <div key={p.page} className="flex items-center gap-3 py-1.5 hover:bg-[#262b3a] rounded px-1">
              <input type="checkbox" checked={sel.has(p.page)} onChange={() => toggle(p.page)} className="w-4 h-4 accent-orange-500 shrink-0 cursor-pointer" />
              <span className="w-5 text-right text-[15px] text-[#8a92a6] shrink-0">{p.page}</span>
              <button onClick={() => toggle(p.page)} className="flex-1 text-left text-[15px] font-bold text-white leading-snug cursor-pointer">{p.name}</button>
              <button
                onClick={() => setLegendPage(legendPage === p.page ? null : p.page)}
                title="Use this page as the discipline's legend"
                className={`shrink-0 text-[11px] font-bold px-2 py-0.5 rounded cursor-pointer ${legendPage === p.page ? 'bg-sky-500 text-white' : 'text-[#6b7280] border border-[#3a4156] hover:text-white'}`}
              >LEGEND</button>
            </div>
          ))}
          {shown.length === 0 && <p className="py-6 text-center text-[#8a92a6]">No pages match.</p>}
        </div>

        <div className="flex items-center justify-between mt-6">
          <span className="text-[15px] font-semibold text-[#8a92a6]" title="Coming soon">Download split PDF</span>
          <div className="flex gap-3">
            <button onClick={onClose} className={btnDark}>Cancel</button>
            <button onClick={go} disabled={sel.size === 0 || busy} className={btnOrange}>{busy ? 'Importing…' : `Import ${sel.size} page${sel.size === 1 ? '' : 's'}`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TakeoffPage() {
  const projectId = useProjectStore((s) => s.openProjectId);
  const takeoffId = useProjectStore((s) => s.openTakeoffId);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === s.openProjectId));
  const takeoff = project?.takeoffs.find((t) => t.id === takeoffId);
  const addDiscipline = useProjectStore((s) => s.addDiscipline);
  const deleteDiscipline = useProjectStore((s) => s.deleteDiscipline);
  const deleteTakeoff = useProjectStore((s) => s.deleteTakeoff);
  const addPdf = useProjectStore((s) => s.addPdf);
  const setLegend = useProjectStore((s) => s.setLegend);
  const deletePdf = useProjectStore((s) => s.deletePdf);
  const openWorkspace = useProjectStore((s) => s.openWorkspace);
  const goProject = useProjectStore((s) => s.goProject);
  const setSitePdf = useAppStore((s) => s.setSitePdf);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [menu, setMenu] = useState<string | null>(null); // 'takeoff' | discipline id | pdf id
  const [pending, setPending] = useState<Pending[]>([]);
  const [importing, setImporting] = useState<ImportState | null>(null);

  if (!project || !takeoff || !projectId || !takeoffId) { goProject(); return null; }

  const addSheet = (d: Discipline, r: { pdf_id: string; filename: string; page_count: number; page_sizes: TakeoffPdf['pageSizes'] }, src?: { pdfId: string; page: number }) => {
    prepareTiles(r.pdf_id).catch(() => undefined); // start tiling now so the sheet opens instantly later
    addPdf(projectId, takeoffId, d.id, {
      pdfId: r.pdf_id, filename: r.filename, pageCount: r.page_count, pageSizes: r.page_sizes,
      uploaded: new Date().toISOString(), sourcePdfId: src?.pdfId, sourcePage: src?.page,
    });
  };

  const upload = async (d: Discipline, files: File[]) => {
    for (const f of files) {
      const key = `${d.id}:${f.name}:${Date.now()}`;
      setPending((p) => [...p, { key, disciplineId: d.id, filename: f.name }]);
      try {
        const r = await uploadPdf(f);
        if (r.page_count <= 1) {
          addSheet(d, r);
        } else {
          const pages = await listPages(r.pdf_id);
          setImporting({ discipline: d, pdfId: r.pdf_id, filename: r.filename, pages });
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setPending((p) => p.filter((x) => x.key !== key));
      }
    }
  };

  const doImport = async (pages: number[], legendPage: number | null) => {
    if (!importing) return;
    const items = await splitPdf(importing.pdfId, pages);
    for (const it of items) addSheet(importing.discipline, it, { pdfId: importing.pdfId, page: it.page });
    const leg = legendPage != null ? items.find((it) => it.page === legendPage) : null;
    if (leg) setLegend(projectId, takeoffId, importing.discipline.id, leg.pdf_id);
    setImporting(null);
  };

  const open = (pdf: TakeoffPdf) => {
    setSitePdf({ pdfId: pdf.pdfId, pdfUrl: getPdfUrl(pdf.pdfId), filename: pdf.filename, pageCount: pdf.pageCount, pageSizes: pdf.pageSizes });
    openWorkspace(projectId, takeoffId, pdf.pdfId);
  };

  const createDiscipline = () => {
    const n = newName.trim();
    if (!n) return;
    addDiscipline(projectId, takeoffId, n);
    setNewName(''); setShowNew(false);
  };

  return (
    <div className="flex h-full w-full bg-[#1f2433] text-[#d5dbe6]" onClick={() => setMenu(null)}>
      <aside className="w-[236px] shrink-0 px-3 py-5 flex flex-col gap-1">
        <button onClick={goProject} className="flex items-center gap-2 px-3 py-2 mb-4 text-sm text-[#aab2c4] hover:text-white cursor-pointer text-left">
          <span className="text-lg leading-none">&larr;</span><span className="truncate">{project.name}</span>
        </button>
        {takeoff.disciplines.map((d) => (
          <a key={d.id} href={`#disc-${d.id}`} className="flex items-center gap-3 px-3 py-3 rounded-md text-sm text-[#d5dbe6] hover:bg-[#272d3f]">
            <IconFolderOpen />
            <span className="flex-1 truncate">{d.name}</span>
            <span className="min-w-7 text-center text-xs px-2 py-1 rounded-full bg-[#2c3245] text-[#aab2c4]">{d.pdfs.length}</span>
          </a>
        ))}
      </aside>

      <main className="flex-1 min-w-0 overflow-auto px-10 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[26px] font-semibold text-white">{takeoff.name}</h1>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowNew(true)} className={btnDark}>New discipline</button>
            <div className="flex h-11 rounded-md overflow-hidden opacity-50 cursor-not-allowed" title="Coming soon">
              <span className="px-4 flex items-center bg-orange-700 text-[15px] font-semibold text-white/80">Export and download</span>
              <span className="w-10 flex items-center justify-center bg-orange-800 text-white/80 border-l border-orange-900">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M6 9l6 6 6-6z"/></svg>
              </span>
            </div>
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); setMenu(menu === 'takeoff' ? null : 'takeoff'); }} className="w-10 h-11 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer"><IconDots /></button>
              {menu === 'takeoff' && (
                <Menu>
                  <button onClick={() => { if (confirm(`Delete "${takeoff.name}"?`)) { deleteTakeoff(projectId, takeoffId); goProject(); } }} className={`${menuItem} text-red-400`}><IconTrash />Delete takeoff…</button>
                </Menu>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-16">
          {takeoff.disciplines.map((d) => (
            <section key={d.id} id={`disc-${d.id}`}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-[17px] font-semibold text-white">{d.name}</h2>
                <div className="relative">
                  <button onClick={(e) => { e.stopPropagation(); setMenu(menu === d.id ? null : d.id); }} className="w-10 h-8 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer"><IconDots /></button>
                  {menu === d.id && (
                    <Menu>
                      <button onClick={() => { if (confirm(`Delete discipline "${d.name}"?`)) deleteDiscipline(projectId, takeoffId, d.id); setMenu(null); }} className={`${menuItem} text-red-400`}><IconTrash />Delete discipline…</button>
                    </Menu>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-5 items-start">
                {d.pdfs.map((pdf) => (
                  <div key={pdf.pdfId} className="w-[300px]">
                    <button onClick={() => open(pdf)} className={`${TILE} block rounded-sm bg-[#2b3140] hover:ring-2 hover:ring-orange-500/70 overflow-hidden cursor-pointer`}>
                      <img src={getThumbUrl(pdf.pdfId)} alt="" className="w-full h-full object-cover object-top" loading="lazy" />
                    </button>
                    <div className="flex items-center gap-2 mt-2 pr-1">
                      {d.legendPdfId === pdf.pdfId
                        ? <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500 text-white">LEGEND</span>
                        : <span className="w-3.5 h-3.5 rounded-full border border-[#8a92a6] shrink-0" />}
                      <span className="flex-1 text-[14px] text-white truncate" title={pdf.filename}>{pdf.filename}</span>
                      <div className="relative">
                        <button onClick={(e) => { e.stopPropagation(); setMenu(menu === pdf.pdfId ? null : pdf.pdfId); }} className="w-8 h-7 flex items-center justify-center text-[#8a92a6] hover:text-white cursor-pointer"><IconDots /></button>
                        {menu === pdf.pdfId && (
                          <Menu>
                            <button onClick={() => { open(pdf); }} className={menuItem}>Open</button>
                            {d.legendPdfId === pdf.pdfId
                              ? <button onClick={() => { setLegend(projectId, takeoffId, d.id, null); setMenu(null); }} className={menuItem}>Remove legend mark</button>
                              : <button onClick={() => { setLegend(projectId, takeoffId, d.id, pdf.pdfId); setMenu(null); }} className={menuItem}>Set as legend</button>}
                            <button onClick={() => { if (confirm(`Remove "${pdf.filename}" from ${d.name}?`)) deletePdf(projectId, takeoffId, d.id, pdf.pdfId); setMenu(null); }} className={`${menuItem} text-red-400`}><IconTrash />Delete…</button>
                          </Menu>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {pending.filter((p) => p.disciplineId === d.id).map((p) => (
                  <div key={p.key} className="w-[300px]">
                    <div className={`${TILE} rounded-sm bg-[#2b3140] flex items-center justify-center`}><Spinner /></div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="w-3.5 h-3.5 rounded-full border border-[#8a92a6] shrink-0" />
                      <span className="text-[14px] text-white truncate">{p.filename}</span>
                    </div>
                  </div>
                ))}
                <DropZone onFiles={(files) => upload(d, files)} />
              </div>
            </section>
          ))}
        </div>
      </main>

      {importing && <ImportPagesModal st={importing} onClose={() => setImporting(null)} onImport={doImport} />}

      {showNew && (
        <Modal title="Create a new discipline" onClose={() => setShowNew(false)}>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-[15px] font-bold text-white">Name</label>
            <span className="text-[13px] text-[#6b7280]">Required</span>
          </div>
          <input autoFocus className={field} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createDiscipline()} />
          <div className="flex justify-end gap-3 mt-8">
            <button onClick={() => setShowNew(false)} className={btnDark}>Cancel</button>
            <button onClick={createDiscipline} disabled={!newName.trim()} className={btnOrange}>Create discipline</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
