export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: T[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      <span className="segmented-label">{label}</span>
      <div className="segmented-options">
        {options.map((option) => (
          <button key={option} className={`segmented-opt${value === option ? ' segmented-opt--active' : ''}`} aria-pressed={value === option} onClick={() => onChange(option)}>{option}</button>
        ))}
      </div>
    </div>
  );
}
