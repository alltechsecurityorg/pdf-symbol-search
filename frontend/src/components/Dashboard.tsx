import { useMemo, useState } from 'react';
import { useProjectStore, type Folder, type Project } from '../store/projectStore';
import { NewProjectModal } from './NewProjectModal';

/* ---- inline icons (no icon lib) ---- */
const ic = 'w-[18px] h-[18px] shrink-0';
const IconFolder = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>);
const IconUser = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>);
const IconArchive = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>);
const IconKits = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>);
const IconProducts = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/></svg>);
const IconPrelims = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20.6 13.4 12 22l-8-8L12.6 5.4A2 2 0 0 1 14 5h5a1 1 0 0 1 1 1v5a2 2 0 0 1-.4 1.4z"/><circle cx="16.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/></svg>);
const IconPriceList = () => (<svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>);
const IconDots = () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>);
const IconDown = () => (<svg className="w-3.5 h-3.5 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>);

function fmtCreated(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('en-AU', { month: 'short' });
  const time = d.toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${month} ${d.getFullYear()}, ${time}`;
}
function fmtDue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${d.toLocaleString('en-AU', { month: 'short' })} ${d.getFullYear()}`;
}
function initials(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '';
}

const FOLDERS: { key: Folder; label: string; icon: () => React.ReactNode }[] = [
  { key: 'active', label: 'Active', icon: IconFolder },
  { key: 'own', label: 'Own', icon: IconUser },
  { key: 'archived', label: 'Archived', icon: IconArchive },
];
const CATALOGUE: { label: string; icon: () => React.ReactNode }[] = [
  { label: 'Kits', icon: IconKits },
  { label: 'Products', icon: IconProducts },
  { label: 'Prelims', icon: IconPrelims },
  { label: 'Price lists', icon: IconPriceList },
];

export function Dashboard() {
  const projects = useProjectStore((s) => s.projects);
  const folder = useProjectStore((s) => s.folder);
  const setFolder = useProjectStore((s) => s.setFolder);
  const filter = useProjectStore((s) => s.filter);
  const setFilter = useProjectStore((s) => s.setFilter);
  const currentUser = useProjectStore((s) => s.currentUser);
  const openProject = useProjectStore((s) => s.openProject);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const unarchiveProject = useProjectStore((s) => s.unarchiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);

  const [showNew, setShowNew] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const counts = useMemo(() => ({
    active: projects.filter((p) => !p.archived).length,
    own: projects.filter((p) => !p.archived && p.owner === currentUser).length,
    archived: projects.filter((p) => p.archived).length,
  }), [projects, currentUser]);

  const rows = useMemo(() => {
    let list = projects;
    if (folder === 'active') list = list.filter((p) => !p.archived);
    else if (folder === 'own') list = list.filter((p) => !p.archived && p.owner === currentUser);
    else list = list.filter((p) => p.archived);
    const q = filter.trim().toLowerCase();
    if (q) list = list.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.customer.toLowerCase().includes(q) ||
      p.buildingType.toLowerCase().includes(q));
    return [...list].sort((a, b) => b.created.localeCompare(a.created));
  }, [projects, folder, filter, currentUser]);

  const title = folder === 'active' ? 'Active' : folder === 'own' ? 'Own' : 'Archived';

  return (
    <div className="flex h-full w-full bg-[#1f2433] text-[#d5dbe6]" onClick={() => setMenuFor(null)}>
      {/* Sidebar */}
      <aside className="w-[236px] shrink-0 bg-[#1f2433] border-r border-[#2c3245] px-3 py-5 flex flex-col gap-6">
        <div>
          <div className="px-3 mb-2 text-[13px] font-semibold text-white">Projects</div>
          <nav className="space-y-0.5">
            {FOLDERS.map(({ key, label, icon: Icon }) => {
              const active = folder === key;
              const count = counts[key];
              return (
                <button
                  key={key}
                  onClick={() => setFolder(key)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors ${active ? 'bg-[#2c3245] text-white' : 'text-[#aab2c4] hover:bg-[#272d3f] hover:text-white'}`}
                >
                  <Icon />
                  <span className="flex-1 text-left">{label}</span>
                  {count > 0 && (
                    <span className={`text-xs px-1.5 py-0.5 rounded ${active ? 'bg-[#1f2433] text-white' : 'bg-[#2c3245] text-[#aab2c4]'}`}>{count}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
        <div>
          <div className="px-3 mb-2 text-[13px] font-semibold text-white">Catalogue</div>
          <nav className="space-y-0.5">
            {CATALOGUE.map(({ label, icon: Icon }) => (
              <button
                key={label}
                title="Coming soon"
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-[#aab2c4] hover:bg-[#272d3f] hover:text-white cursor-pointer"
              >
                <Icon />
                <span className="flex-1 text-left">{label}</span>
              </button>
            ))}
          </nav>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-auto px-10 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-semibold text-white">{title}</h1>
          <div className="flex items-center gap-3">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter projects"
              className="w-64 bg-[#262c3d] border border-[#3a4156] rounded-md px-3 py-2 text-sm text-white placeholder-[#7c8496] focus:outline-none focus:border-orange-500"
            />
            <button
              onClick={() => setShowNew(true)}
              title="New project"
              className="w-10 h-10 flex items-center justify-center rounded-md bg-orange-500 hover:bg-orange-600 text-white text-2xl leading-none cursor-pointer"
            >
              +
            </button>
          </div>
        </div>

        {/* Table */}
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-[#8a92a6] border-b border-[#2c3245]">
              <th className="text-left font-medium py-3 pr-4">Project name</th>
              <th className="text-left font-medium py-3 pr-4">Customer</th>
              <th className="text-left font-medium py-3 pr-4">Building type</th>
              <th className="text-left font-medium py-3 pr-4">Owner</th>
              <th className="text-left font-medium py-3 pr-4">Status</th>
              <th className="text-left font-medium py-3 pr-4"><IconDown /> Created</th>
              <th className="text-left font-medium py-3 pr-4">Due date</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="py-16 text-center text-[#8a92a6] text-sm">No projects here yet. Hit the orange + to create one.</td></tr>
            )}
            {rows.map((p: Project) => (
              <tr
                key={p.id}
                onClick={() => openProject(p.id)}
                className="border-b border-[#2a3043] hover:bg-[#272d3f] cursor-pointer group"
              >
                <td className="py-4 pr-4">
                  <div className="flex items-center gap-2.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: p.status === 'Won' ? '#34d399' : 'transparent' }} />
                    <span className="text-white font-medium">{p.name}</span>
                  </div>
                </td>
                <td className="py-4 pr-4 text-[#d5dbe6]">{p.customer}</td>
                <td className="py-4 pr-4 text-[#d5dbe6]">{p.buildingType}</td>
                <td className="py-4 pr-4">
                  {p.owner && (
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-teal-500/70 text-white text-xs flex items-center justify-center font-semibold">{initials(p.owner)}</span>
                      <span>{p.owner}</span>
                    </div>
                  )}
                </td>
                <td className="py-4 pr-4 text-white">{p.status}</td>
                <td className="py-4 pr-4 text-[#d5dbe6] whitespace-nowrap">{fmtCreated(p.created)}</td>
                <td className="py-4 pr-4 text-[#d5dbe6] whitespace-nowrap">{fmtDue(p.dueDate)}</td>
                <td className="py-4 relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id); }}
                    className="text-[#8a92a6] hover:text-white cursor-pointer"
                  >
                    <IconDots />
                  </button>
                  {menuFor === p.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-6 top-10 z-20 w-40 bg-[#262c3d] border border-[#3a4156] rounded-md shadow-xl py-1 text-sm"
                    >
                      <button onClick={() => { openProject(p.id); }} className="block w-full text-left px-3 py-2 hover:bg-[#323950] text-[#d5dbe6] cursor-pointer">Open</button>
                      {p.archived ? (
                        <button onClick={() => { unarchiveProject(p.id); setMenuFor(null); }} className="block w-full text-left px-3 py-2 hover:bg-[#323950] text-[#d5dbe6] cursor-pointer">Unarchive</button>
                      ) : (
                        <button onClick={() => { archiveProject(p.id); setMenuFor(null); }} className="block w-full text-left px-3 py-2 hover:bg-[#323950] text-[#d5dbe6] cursor-pointer">Archive</button>
                      )}
                      <button onClick={() => { if (confirm(`Delete "${p.name}"?`)) deleteProject(p.id); setMenuFor(null); }} className="block w-full text-left px-3 py-2 hover:bg-[#323950] text-red-400 cursor-pointer">Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
