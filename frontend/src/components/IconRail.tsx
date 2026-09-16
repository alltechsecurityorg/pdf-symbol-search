const items: { label: string; icon: React.ReactNode; active?: boolean }[] = [
  { label: 'Count', active: true, icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3L7 21M17 3l-2 18M4 9h17M3 15h17"/></svg> },
  { label: 'Measure', icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 17L17 3l4 4L7 21H3v-4zM7 13l2 2M10 10l2 2M13 7l2 2"/></svg> },
  { label: 'Zone', icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 2"/><path d="M8 12h8M12 8v8"/></svg> },
  { label: 'Note', icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16v10H9l-5 4V5z"/></svg> },
  { label: 'Layout', icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5"/></svg> },
  { label: 'Page', icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6"/></svg> },
];

export function IconRail() {
  return (
    <nav className="w-12 shrink-0 bg-[#161a26] flex flex-col items-stretch pt-2">
      {items.map((it) => (
        <button key={it.label} title={it.active ? it.label : `${it.label} — coming soon`}
          className={`flex flex-col items-center gap-1 py-3 text-[10px] cursor-pointer ${it.active ? 'bg-[#1f2433] text-white' : 'text-[#8a92a6] hover:text-white'}`}>
          {it.icon}<span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
