import { useState } from 'react';
import { useProjectStore, STATUSES, type ProjectStatus, type Takeoff } from '../store/projectStore';
import { Modal, Menu, field, btnDark, btnOrange, btnRed, menuItem, IconDots, IconTrash } from './ui';

const ic = 'w-[18px] h-[18px] shrink-0';
const IconTakeoff = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20l4-4M14 4l6 6-8 8H8v-4l6-6zM15 3l6 6"/></svg>);
const IconEstimate = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="#1f2433"/><circle cx="15" cy="12" r="2" fill="#1f2433"/><circle cx="10" cy="18" r="2" fill="#1f2433"/></svg>);
const IconSpec = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h3M9 5h11M4 12h3M9 12h11M4 19h3M9 19h11"/></svg>);

function fmtCreated(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleString('en-AU', { month: 'short' })} ${d.getFullYear()}, ${d.toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function NameModal({ title, cta, initial, onSubmit, onClose }: { title: string; cta: string; initial: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0;
  const go = () => { if (ok) onSubmit(name.trim()); };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex items-baseline justify-between mb-2">
        <label className="text-[15px] font-bold text-white">Name</label>
        <span className="text-[13px] text-[#6b7280]">Required</span>
      </div>
      <input autoFocus className={field} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} onFocus={(e) => e.target.select()} />
      <div className="flex justify-end gap-3 mt-8">
        <button onClick={onClose} className={btnDark}>Cancel</button>
        <button onClick={go} disabled={!ok} className={btnOrange}>{cta}</button>
      </div>
    </Modal>
  );
}

function Card({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-lg bg-[#262b3a] shadow-lg">
      <div className="flex items-center justify-between px-6 h-14 bg-[#2a3040] rounded-t-lg">
        <h2 className="text-[17px] font-semibold text-white">{title}</h2>
        <button onClick={onAdd} title={onAdd ? 'New' : 'Coming soon'} className="w-10 h-10 flex items-center justify-center rounded-md bg-orange-500 hover:bg-orange-600 text-white text-2xl leading-none cursor-pointer">+</button>
      </div>
      <div>{children}</div>
    </section>
  );
}

function Empty({ text, onCreate }: { text: string; onCreate?: () => void }) {
  return (
    <div className="py-6 text-center text-[15px] text-[#d5dbe6]">
      {text},{' '}
      <button onClick={onCreate} className="text-sky-400 font-semibold hover:underline cursor-pointer">create one</button>
    </div>
  );
}

type Dialog =
  | { kind: 'new' }
  | { kind: 'move'; t: Takeoff }
  | { kind: 'dup'; t: Takeoff }
  | { kind: 'del'; t: Takeoff }
  | null;

export function ProjectPage() {
  const projectId = useProjectStore((s) => s.openProjectId);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === s.openProjectId));
  const allProjects = useProjectStore((s) => s.projects);
  const setStatus = useProjectStore((s) => s.setStatus);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const unarchiveProject = useProjectStore((s) => s.unarchiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const addTakeoff = useProjectStore((s) => s.addTakeoff);
  const deleteTakeoff = useProjectStore((s) => s.deleteTakeoff);
  const moveTakeoff = useProjectStore((s) => s.moveTakeoff);
  const duplicateTakeoff = useProjectStore((s) => s.duplicateTakeoff);
  const openTakeoff = useProjectStore((s) => s.openTakeoff);
  const goDashboard = useProjectStore((s) => s.goDashboard);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<string | null>(null); // 'project' | takeoff id
  const [moveTo, setMoveTo] = useState('');

  if (!project || !projectId) { goDashboard(); return null; }

  const others = allProjects.filter((p) => p.id !== projectId && !p.archived);
  const nav = [
    { label: 'Takeoffs', icon: IconTakeoff, count: project.takeoffs.length },
    { label: 'Estimates', icon: IconEstimate, count: 0 },
    { label: 'Specifications', icon: IconSpec, count: 0 },
  ];

  return (
    <div className="flex h-full w-full bg-[#1f2433] text-[#d5dbe6]" onClick={() => setMenu(null)}>
      <aside className="w-[236px] shrink-0 px-3 py-5 flex flex-col gap-1">
        <button onClick={goDashboard} className="flex items-center gap-2 px-3 py-2 mb-4 text-sm text-[#aab2c4] hover:text-white cursor-pointer">
          <span className="text-lg leading-none">&larr;</span> Projects
        </button>
        {nav.map(({ label, icon: Icon, count }) => (
          <div key={label} className="flex items-center gap-3 px-3 py-3 rounded-md text-sm text-[#d5dbe6]">
            <Icon />
            <span className="flex-1">{label}</span>
            <span className="min-w-7 text-center text-xs px-2 py-1 rounded-full bg-[#2c3245] text-[#aab2c4]">{count}</span>
          </div>
        ))}
      </aside>

      <main className="flex-1 min-w-0 overflow-auto px-10 py-8">
        <div className="flex items-start justify-between mb-2">
          <h1 className="text-[26px] font-semibold text-white">{project.name}</h1>
          <div className="flex items-center gap-3">
            <div className="relative">
              <select value={project.status} onChange={(e) => setStatus(project.id, e.target.value as ProjectStatus)}
                className="appearance-none h-11 w-56 bg-[#262c3d] border border-[#3a4156] rounded-md pl-4 pr-10 text-[15px] font-semibold text-white focus:outline-none focus:border-orange-500 cursor-pointer">
                {STATUSES.map((s) => <option key={s} value={s} className="bg-[#262c3d]">{s}</option>)}
              </select>
              <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#d5dbe6]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); setMenu(menu === 'project' ? null : 'project'); }} className="w-10 h-11 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer"><IconDots /></button>
              {menu === 'project' && (
                <Menu>
                  {project.archived
                    ? <button onClick={() => { unarchiveProject(project.id); setMenu(null); }} className={menuItem}>Unarchive</button>
                    : <button onClick={() => { archiveProject(project.id); setMenu(null); }} className={menuItem}>Archive</button>}
                  <button onClick={() => { if (confirm(`Delete "${project.name}"?`)) { deleteProject(project.id); goDashboard(); } }} className={`${menuItem} text-red-400`}><IconTrash />Delete…</button>
                </Menu>
              )}
            </div>
          </div>
        </div>

        {project.owner && (
          <div className="flex items-center gap-2.5 mb-10">
            <span className="w-7 h-7 rounded-full bg-teal-500/70 text-white text-sm flex items-center justify-center font-semibold">{project.owner.trim()[0]?.toUpperCase()}</span>
            <span className="text-[15px] text-white">{project.owner}</span>
          </div>
        )}

        <div className="space-y-8">
          <Card title="Takeoffs" onAdd={() => setDialog({ kind: 'new' })}>
            {project.takeoffs.length === 0
              ? <Empty text="No takeoffs yet" onCreate={() => setDialog({ kind: 'new' })} />
              : project.takeoffs.map((t) => (
                <div key={t.id} onClick={() => openTakeoff(project.id, t.id)}
                  className="flex items-center justify-between px-6 py-5 border-t border-[#2c3245] hover:bg-[#2a3040] cursor-pointer">
                  <div>
                    <div className="text-[15px] font-bold text-white">{t.name}</div>
                    <div className="text-[14px] text-[#d5dbe6] mt-0.5">Created on {fmtCreated(t.created)}</div>
                  </div>
                  <div className="relative">
                    <button onClick={(e) => { e.stopPropagation(); setMenu(menu === t.id ? null : t.id); }} className="w-10 h-10 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer"><IconDots /></button>
                    {menu === t.id && (
                      <Menu>
                        <button onClick={() => { setMoveTo(others[0]?.id ?? ''); setDialog({ kind: 'move', t }); setMenu(null); }} className={menuItem}>Move to project…</button>
                        <button onClick={() => { setDialog({ kind: 'dup', t }); setMenu(null); }} className={menuItem}>Duplicate…</button>
                        <button onClick={() => { setDialog({ kind: 'del', t }); setMenu(null); }} className={`${menuItem} text-red-400`}><IconTrash />Delete…</button>
                      </Menu>
                    )}
                  </div>
                </div>
              ))}
          </Card>
          <Card title="Estimates"><Empty text="No estimates yet" /></Card>
          <Card title="Specifications"><Empty text="No specification comparisons yet" /></Card>
        </div>
      </main>

      {dialog?.kind === 'new' && (
        <NameModal title="Create a new takeoff" cta="Create takeoff" initial={`Rev ${project.takeoffs.length}`}
          onClose={() => setDialog(null)}
          onSubmit={(name) => { const id = addTakeoff(project.id, name); setDialog(null); openTakeoff(project.id, id); }} />
      )}
      {dialog?.kind === 'dup' && (
        <NameModal title="Duplicate takeoff" cta="Duplicate" initial={`${dialog.t.name} copy`}
          onClose={() => setDialog(null)}
          onSubmit={(name) => { duplicateTakeoff(project.id, dialog.t.id, name); setDialog(null); }} />
      )}
      {dialog?.kind === 'move' && (
        <Modal title="Move takeoff to project" onClose={() => setDialog(null)}>
          {others.length === 0 ? (
            <p className="text-[15px] text-[#aab2c4]">There are no other active projects to move “{dialog.t.name}” to.</p>
          ) : (
            <>
              <label className="block text-[15px] font-bold text-white mb-2">Project</label>
              <div className="relative">
                <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={`${field} appearance-none pr-10 cursor-pointer`}>
                  {others.map((p) => <option key={p.id} value={p.id} className="bg-[#181c28]">{p.name}</option>)}
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#d5dbe6]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6"/></svg>
              </div>
            </>
          )}
          <div className="flex justify-end gap-3 mt-8">
            <button onClick={() => setDialog(null)} className={btnDark}>Cancel</button>
            {others.length > 0 && <button onClick={() => { moveTakeoff(project.id, dialog.t.id, moveTo); setDialog(null); }} className={btnOrange}>Move</button>}
          </div>
        </Modal>
      )}
      {dialog?.kind === 'del' && (
        <Modal title="Delete takeoff" onClose={() => setDialog(null)}>
          <p className="text-[15px] text-[#d5dbe6]">Are you sure you want to delete <span className="font-bold text-white">“{dialog.t.name}”</span>? This can’t be undone.</p>
          <div className="flex justify-end gap-3 mt-8">
            <button onClick={() => setDialog(null)} className={btnDark}>Cancel</button>
            <button onClick={() => { deleteTakeoff(project.id, dialog.t.id); setDialog(null); }} className={btnRed}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
