import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';

export type ProjectStatus = 'Takeoff' | 'Quoting' | 'Won' | 'Lost' | 'On hold';
export const STATUSES: ProjectStatus[] = ['Takeoff', 'Quoting', 'Won', 'Lost', 'On hold'];
export type Folder = 'active' | 'own' | 'archived';

export interface TakeoffPdf {
  pdfId: string;
  filename: string;
  pageCount: number;
  pageSizes: { page: number; width_pts: number; height_pts: number }[];
  uploaded: string; // ISO
  sourcePdfId?: string; // multi-page upload this sheet was split from
  sourcePage?: number;
}
export interface LegendItem {
  id: string;
  name: string;
  color: string;
  thumbnail: string;
  templateId: string;
  cropRegion: { page: number; x: number; y: number; width: number; height: number };
}
export interface Discipline { id: string; name: string; pdfs: TakeoffPdf[]; legendPdfId?: string | null; legendItems?: LegendItem[] }
export interface Takeoff { id: string; name: string; revision: number; created: string; disciplines: Discipline[] }

export interface Project {
  id: string;
  name: string;
  customer: string;
  buildingType: string;
  owner: string;
  status: ProjectStatus;
  created: string;        // ISO
  dueDate: string | null; // YYYY-MM-DD or null
  archived: boolean;
  takeoffs: Takeoff[];
}

const CURRENT_USER = 'Alex Stath';
const DEFAULT_DISCIPLINES = ['Data', 'Fire and Security', 'Lighting', 'Power'];
const mkDiscipline = (name: string): Discipline => ({ id: uuidv4(), name, pdfs: [] });

function seed(): Project[] {
  return [
    { id: uuidv4(), name: 'test', customer: '', buildingType: '', owner: 'Alex Stath',
      status: 'Takeoff', created: '2026-09-11T13:41:00', dueDate: null, archived: false, takeoffs: [] },
    { id: uuidv4(), name: 'Demo project', customer: 'Countfire', buildingType: 'Office fit out', owner: '',
      status: 'Won', created: '2026-09-11T13:39:00', dueDate: '2026-09-18', archived: false, takeoffs: [] },
  ];
}

type View = 'dashboard' | 'project' | 'takeoff' | 'workspace';

interface ProjectState {
  projects: Project[];
  // UI (not persisted)
  view: View;
  openProjectId: string | null;
  openTakeoffId: string | null;
  openPdfId: string | null;
  folder: Folder;
  filter: string;
  currentUser: string;

  addProject: (p: Omit<Project, 'id' | 'created' | 'archived' | 'takeoffs'>) => string;
  setStatus: (id: string, status: ProjectStatus) => void;
  archiveProject: (id: string) => void;
  unarchiveProject: (id: string) => void;
  deleteProject: (id: string) => void;
  addTakeoff: (projectId: string, name: string) => string;
  deleteTakeoff: (projectId: string, takeoffId: string) => void;
  moveTakeoff: (fromProjectId: string, takeoffId: string, toProjectId: string) => void;
  duplicateTakeoff: (projectId: string, takeoffId: string, name: string) => string;
  addDiscipline: (projectId: string, takeoffId: string, name: string) => void;
  deleteDiscipline: (projectId: string, takeoffId: string, disciplineId: string) => void;
  addPdf: (projectId: string, takeoffId: string, disciplineId: string, pdf: TakeoffPdf) => void;
  setLegend: (projectId: string, takeoffId: string, disciplineId: string, pdfId: string | null) => void;
  addLegendItem: (projectId: string, takeoffId: string, disciplineId: string, item: Omit<LegendItem, 'id'>) => void;
  updateLegendItem: (projectId: string, takeoffId: string, disciplineId: string, templateId: string, patch: Partial<Pick<LegendItem, 'name' | 'color'>>) => void;
  removeLegendItem: (projectId: string, takeoffId: string, disciplineId: string, templateId: string) => void;
  deletePdf: (projectId: string, takeoffId: string, disciplineId: string, pdfId: string) => void;

  openProject: (id: string) => void;
  openTakeoff: (projectId: string, takeoffId: string) => void;
  openWorkspace: (projectId: string, takeoffId: string, pdfId: string) => void;
  goTakeoff: () => void;
  goProject: () => void;
  goDashboard: () => void;
  setFolder: (f: Folder) => void;
  setFilter: (s: string) => void;
}

// Immutable update of one takeoff inside one project
const updTakeoff = (projects: Project[], projectId: string, takeoffId: string, fn: (t: Takeoff) => Takeoff) =>
  projects.map((p) => p.id !== projectId ? p : { ...p, takeoffs: p.takeoffs.map((t) => (t.id !== takeoffId ? t : fn(t))) });

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projects: seed(),
      view: 'dashboard',
      openProjectId: null,
      openTakeoffId: null,
      openPdfId: null,
      folder: 'active',
      filter: '',
      currentUser: CURRENT_USER,

      addProject: (p) => {
        const id = uuidv4();
        set((s) => ({ projects: [{ ...p, id, created: new Date().toISOString(), archived: false, takeoffs: [] }, ...s.projects] }));
        return id;
      },
      setStatus: (id, status) => set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, status } : p)) })),
      archiveProject: (id) => set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, archived: true } : p)) })),
      unarchiveProject: (id) => set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, archived: false } : p)) })),
      deleteProject: (id) => set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),

      addTakeoff: (projectId, name) => {
        const id = uuidv4();
        const t: Takeoff = { id, name, revision: 0, created: new Date().toISOString(), disciplines: DEFAULT_DISCIPLINES.map(mkDiscipline) };
        set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, takeoffs: [...p.takeoffs, t] } : p)) }));
        return id;
      },
      deleteTakeoff: (projectId, takeoffId) =>
        set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, takeoffs: p.takeoffs.filter((t) => t.id !== takeoffId) } : p)) })),
      moveTakeoff: (fromProjectId, takeoffId, toProjectId) =>
        set((s) => {
          const t = s.projects.find((p) => p.id === fromProjectId)?.takeoffs.find((x) => x.id === takeoffId);
          if (!t || fromProjectId === toProjectId) return s;
          return { projects: s.projects.map((p) =>
            p.id === fromProjectId ? { ...p, takeoffs: p.takeoffs.filter((x) => x.id !== takeoffId) }
            : p.id === toProjectId ? { ...p, takeoffs: [...p.takeoffs, t] } : p) };
        }),
      duplicateTakeoff: (projectId, takeoffId, name) => {
        const id = uuidv4();
        set((s) => {
          const t = s.projects.find((p) => p.id === projectId)?.takeoffs.find((x) => x.id === takeoffId);
          if (!t) return s;
          // PDFs are immutable uploads, so the copy can share pdfIds
          const copy: Takeoff = { ...t, id, name, created: new Date().toISOString(),
            disciplines: t.disciplines.map((d) => ({ ...d, id: uuidv4(), pdfs: [...d.pdfs] })) };
          return { projects: s.projects.map((p) => (p.id === projectId ? { ...p, takeoffs: [...p.takeoffs, copy] } : p)) };
        });
        return id;
      },
      addDiscipline: (projectId, takeoffId, name) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({ ...t, disciplines: [...t.disciplines, mkDiscipline(name)] })) })),
      deleteDiscipline: (projectId, takeoffId, disciplineId) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({ ...t, disciplines: t.disciplines.filter((d) => d.id !== disciplineId) })) })),
      addPdf: (projectId, takeoffId, disciplineId, pdf) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({
          ...t, disciplines: t.disciplines.map((d) => (d.id === disciplineId ? { ...d, pdfs: [...d.pdfs, pdf] } : d)),
        })) })),

      setLegend: (projectId, takeoffId, disciplineId, pdfId) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({
          ...t, disciplines: t.disciplines.map((d) => (d.id === disciplineId ? { ...d, legendPdfId: pdfId } : d)),
        })) })),
      addLegendItem: (projectId, takeoffId, disciplineId, item) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({
          ...t, disciplines: t.disciplines.map((d) => (d.id === disciplineId ? { ...d, legendItems: [...(d.legendItems ?? []), { ...item, id: uuidv4() }] } : d)),
        })) })),
      updateLegendItem: (projectId, takeoffId, disciplineId, templateId, patch) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({
          ...t, disciplines: t.disciplines.map((d) => (d.id === disciplineId
            ? { ...d, legendItems: (d.legendItems ?? []).map((i) => (i.templateId === templateId ? { ...i, ...patch } : i)) } : d)),
        })) })),
      removeLegendItem: (projectId, takeoffId, disciplineId, templateId) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({
          ...t, disciplines: t.disciplines.map((d) => (d.id === disciplineId
            ? { ...d, legendItems: (d.legendItems ?? []).filter((i) => i.templateId !== templateId) } : d)),
        })) })),
      deletePdf: (projectId, takeoffId, disciplineId, pdfId) =>
        set((s) => ({ projects: updTakeoff(s.projects, projectId, takeoffId, (t) => ({
          ...t, disciplines: t.disciplines.map((d) => (d.id === disciplineId ? { ...d, pdfs: d.pdfs.filter((f) => f.pdfId !== pdfId), legendPdfId: d.legendPdfId === pdfId ? null : d.legendPdfId } : d)),
        })) })),
      openProject: (id) => set({ view: 'project', openProjectId: id, openTakeoffId: null, openPdfId: null }),
      openTakeoff: (projectId, takeoffId) => set({ view: 'takeoff', openProjectId: projectId, openTakeoffId: takeoffId, openPdfId: null }),
      openWorkspace: (projectId, takeoffId, pdfId) => set({ view: 'workspace', openProjectId: projectId, openTakeoffId: takeoffId, openPdfId: pdfId }),
      goTakeoff: () => set({ view: 'takeoff', openPdfId: null }),
      goProject: () => set({ view: 'project', openTakeoffId: null, openPdfId: null }),
      goDashboard: () => set({ view: 'dashboard', openProjectId: null, openTakeoffId: null, openPdfId: null }),
      setFolder: (folder) => set({ folder }),
      setFilter: (filter) => set({ filter }),
    }),
    {
      name: 'pss-projects',
      version: 3,
      partialize: (s) => ({ projects: s.projects }),
      // Older saves: add takeoffs (v1) and revision/disciplines on takeoffs (v2)
      migrate: (persisted) => {
        const st = persisted as { projects?: Project[] };
        return {
          projects: (st.projects ?? []).map((p) => ({
            ...p,
            takeoffs: (p.takeoffs ?? []).map((t) => ({
              ...t,
              revision: t.revision ?? 0,
              disciplines: t.disciplines ?? DEFAULT_DISCIPLINES.map(mkDiscipline),
            })),
          })),
        };
      },
    }
  )
);
