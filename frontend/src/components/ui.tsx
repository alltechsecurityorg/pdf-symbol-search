// Shared bits for the dark modal/menu look used across the project pages.
export const field = 'w-full h-11 bg-[#181c28] border border-[#353b4d] rounded-md px-3 text-[15px] text-white focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500';
export const btnDark = 'px-5 h-11 rounded-md bg-[#262c3d] border border-[#3a4156] text-[15px] font-semibold text-white hover:bg-[#2f3649] cursor-pointer';
export const btnOrange = 'px-5 h-11 rounded-md bg-orange-500 hover:bg-orange-600 text-[15px] font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer';
export const btnRed = 'px-5 h-11 rounded-md bg-red-600 hover:bg-red-700 text-[15px] font-bold text-white cursor-pointer';
export const menuItem = 'block w-full text-left px-4 py-2.5 hover:bg-[#323950] text-[15px] text-white cursor-pointer';

export const IconDots = () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>);
export const IconTrash = () => (<svg className="w-4 h-4 inline-block mr-2 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>);

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="relative w-[496px] bg-[#1f2433] rounded-lg shadow-2xl px-6 pt-5 pb-6" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-3 text-[#aab2c4] hover:text-white text-2xl leading-none cursor-pointer">&times;</button>
        <h2 className="text-[19px] font-semibold text-white mb-6">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Menu({ children }: { children: React.ReactNode }) {
  return (
    <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-10 z-20 w-[216px] bg-[#262c3d] border border-[#3a4156] rounded-md shadow-xl py-1.5">
      {children}
    </div>
  );
}
