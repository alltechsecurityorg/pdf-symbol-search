import { useState } from 'react';
import { PDFViewer } from './components/PDFViewer';
import { LegendPanel } from './components/LegendPanel';

function App() {
  const [bannerVisible, setBannerVisible] = useState(true);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#1a1a2e]">
      {bannerVisible && (
        <div className="bg-amber-600 text-white text-sm px-4 py-2 flex items-center justify-between shrink-0">
          <span>
            Performance may be slower than expected — this demo is running on a small AWS server. It will be faster when Jamon buys a server.
          </span>
          <button
            onClick={() => setBannerVisible(false)}
            className="ml-4 text-white/80 hover:text-white font-bold text-lg leading-none cursor-pointer"
          >
            &times;
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        <PDFViewer />
        <LegendPanel />
      </div>
    </div>
  );
}

export default App;
