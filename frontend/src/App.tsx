import { SheetViewer } from './components/SheetViewer';
import { LegendPanel } from './components/LegendPanel';
import { Dashboard } from './components/Dashboard';
import { ProjectPage } from './components/ProjectPage';
import { TakeoffPage } from './components/TakeoffPage';
import { IconRail } from './components/IconRail';
import { useProjectStore } from './store/projectStore';

function App() {
  const view = useProjectStore((s) => s.view);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === s.openProjectId));
  const takeoff = useProjectStore((s) => s.projects.find((p) => p.id === s.openProjectId)?.takeoffs.find((t) => t.id === s.openTakeoffId));
  const pdfName = useProjectStore((s) => {
    const t = s.projects.find((p) => p.id === s.openProjectId)?.takeoffs.find((t) => t.id === s.openTakeoffId);
    return t?.disciplines.flatMap((d) => d.pdfs).find((f) => f.pdfId === s.openPdfId)?.filename;
  });
  const goDashboard = useProjectStore((s) => s.goDashboard);
  const goProject = useProjectStore((s) => s.goProject);
  const goTakeoff = useProjectStore((s) => s.goTakeoff);

  if (view === 'dashboard') return <div className="h-screen w-screen"><Dashboard /></div>;
  if (view === 'project') return <div className="h-screen w-screen"><ProjectPage /></div>;
  if (view === 'takeoff') return <div className="h-screen w-screen"><TakeoffPage /></div>;

  const crumb = 'text-[#aab2c4] hover:text-white cursor-pointer truncate';
  const sep = <span className="text-[#3a4156]">/</span>;
  return (
    <div className="h-screen w-screen flex flex-col bg-[#1f2433]">
      <header className="h-11 shrink-0 flex items-center gap-2 px-4 bg-[#161a26] border-b border-[#2c3245] text-sm">
        <button onClick={goDashboard} className={crumb}>Projects</button>{sep}
        <button onClick={goProject} className={crumb}>{project?.name ?? 'Project'}</button>{sep}
        <button onClick={goTakeoff} className={crumb}>{takeoff?.name ?? 'Takeoff'}</button>{sep}
        <span className="text-white font-medium truncate">{pdfName ?? 'PDF'}</span>
      </header>
      <div className="flex flex-1 min-h-0">
        <IconRail />
        <LegendPanel />
        <SheetViewer />
      </div>
    </div>
  );
}

export default App;
