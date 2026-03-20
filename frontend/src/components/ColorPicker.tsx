import { useState } from 'react';

const PRESET_COLORS = [
  '#22c55e', // green
  '#ef4444', // red
  '#3b82f6', // blue
  '#f97316', // orange
  '#a855f7', // purple
  '#eab308', // yellow
  '#06b6d4', // cyan
  '#ec4899', // magenta
];

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
}

export function ColorPicker({ color, onChange }: ColorPickerProps) {
  const [showCustom, setShowCustom] = useState(false);

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className="w-6 h-6 rounded border-2 cursor-pointer transition-transform hover:scale-110"
          style={{
            backgroundColor: c,
            borderColor: color === c ? '#fff' : 'transparent',
          }}
        />
      ))}
      <button
        onClick={() => setShowCustom(!showCustom)}
        className="w-6 h-6 rounded border border-gray-500 text-xs cursor-pointer bg-transparent text-gray-300 hover:border-gray-300"
      >
        #
      </button>
      {showCustom && (
        <input
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-6 cursor-pointer bg-transparent border-0"
        />
      )}
    </div>
  );
}

export { PRESET_COLORS };
