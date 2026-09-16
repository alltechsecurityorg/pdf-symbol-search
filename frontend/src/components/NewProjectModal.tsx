import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { DatePicker } from './DatePicker';

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const addProject = useProjectStore((s) => s.addProject);
  const openProject = useProjectStore((s) => s.openProject);
  const currentUser = useProjectStore((s) => s.currentUser);

  const [name, setName] = useState('');
  const [owner, setOwner] = useState(currentUser);
  const [customer, setCustomer] = useState('');
  const [buildingType, setBuildingType] = useState('');
  const [dueDate, setDueDate] = useState<string | null>(null);

  const canCreate = name.trim().length > 0;

  const submit = () => {
    if (!canCreate) return;
    const id = addProject({
      name: name.trim(),
      owner,
      customer: customer.trim(),
      buildingType: buildingType.trim(),
      status: 'Takeoff',
      dueDate,
    });
    onClose();
    openProject(id);
  };

  const field =
    'w-full h-11 bg-[#181c28] border border-[#353b4d] rounded-md px-3 text-[15px] text-white ' +
    'focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500';
  const label = 'block text-[15px] font-bold text-white mb-2';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="relative w-[496px] bg-[#1f2433] rounded-lg shadow-2xl px-6 pt-5 pb-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLInputElement).readOnly) submit(); }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-3 text-[#aab2c4] hover:text-white text-2xl leading-none cursor-pointer"
        >
          &times;
        </button>
        <h2 className="text-[19px] font-semibold text-white mb-6">Create a new project</h2>

        <div className="space-y-5">
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-[15px] font-bold text-white">Name</label>
              <span className="text-[13px] text-[#6b7280]">Required</span>
            </div>
            <input autoFocus className={field} value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className={label}>Owner</label>
            <div className="relative">
              <select
                className={`${field} appearance-none pr-10 cursor-pointer`}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              >
                <option value={currentUser} className="bg-[#181c28]">{currentUser}</option>
              </select>
              <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#d5dbe6]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6"/></svg>
            </div>
          </div>

          <div>
            <label className={label}>Customer</label>
            <input className={field} value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>

          <div>
            <label className={label}>Building type</label>
            <input className={field} value={buildingType} onChange={(e) => setBuildingType(e.target.value)} />
          </div>

          <div>
            <label className={label}>Due date</label>
            <DatePicker value={dueDate} onChange={setDueDate} className={field} />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-8">
          <button
            onClick={onClose}
            className="px-5 h-11 rounded-md bg-[#262c3d] border border-[#3a4156] text-[15px] font-semibold text-white hover:bg-[#2f3649] cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canCreate}
            className="px-5 h-11 rounded-md bg-orange-500 hover:bg-orange-600 text-[15px] font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}
