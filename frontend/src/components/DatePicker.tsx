import { useEffect, useRef, useState } from 'react';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function toISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function fmt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${d.toLocaleString('en-AU', { month: 'short' })} ${d.getFullYear()}`;
}

interface Props {
  value: string | null;          // YYYY-MM-DD
  onChange: (iso: string | null) => void;
  className?: string;
}

export function DatePicker({ value, onChange, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const today = new Date();
  const initial = value ? new Date(value + 'T00:00:00') : today;
  const [view, setView] = useState({ y: initial.getFullYear(), m: initial.getMonth() });
  const wrap = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Build the day grid: leading days from previous month, this month, trailing to fill rows
  const first = new Date(view.y, view.m, 1);
  const lead = first.getDay(); // Sunday-start
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const rows = Math.ceil((lead + daysInMonth) / 7);
  const cells: { d: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(view.y, view.m, 1 - lead + i);
    cells.push({ d, inMonth: d.getMonth() === view.m });
  }

  const todayISO = toISO(today);
  const monthLabel = first.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  const shift = (n: number) => {
    const d = new Date(view.y, view.m + n, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  return (
    <div ref={wrap} className="relative">
      <input
        readOnly
        value={fmt(value)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        className={className}
      />
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-[236px] bg-[#1f2433] border border-[#2c3245] rounded-md shadow-2xl p-2.5 select-none">
          <div className="flex items-center justify-between mb-2 px-1">
            <button type="button" onClick={() => shift(-1)} className="w-6 h-6 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 6l-6 6 6 6"/></svg>
            </button>
            <span className="text-sm font-semibold text-white">{monthLabel}</span>
            <button type="button" onClick={() => shift(1)} className="w-6 h-6 flex items-center justify-center text-[#aab2c4] hover:text-white cursor-pointer">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 6l6 6-6 6"/></svg>
            </button>
          </div>
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((w) => (
              <div key={w} className="h-7 flex items-center justify-center text-[11px] font-semibold text-[#d5dbe6]">{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map(({ d, inMonth }) => {
              const iso = toISO(d);
              const selected = iso === value;
              const isToday = iso === todayISO;
              return (
                <button
                  type="button"
                  key={iso}
                  onClick={() => { onChange(iso); setOpen(false); }}
                  className={`h-8 w-8 mx-auto rounded-full text-[13px] flex items-center justify-center cursor-pointer transition-colors
                    ${selected ? 'bg-orange-500 text-white font-bold'
                      : inMonth ? 'text-white hover:bg-[#2c3245]' : 'text-[#4b5364] hover:bg-[#2c3245]'}
                    ${isToday && !selected ? 'font-bold' : ''}`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
