interface FilterChipsProps<T extends string> {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}

export function FilterChips<T extends string>({ options, value, onChange }: FilterChipsProps<T>) {
  return (
    <div className="flex gap-2 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`inline-flex min-h-9 items-center rounded-control border px-3 text-label font-medium transition-colors md:min-h-[30px] ${
            value === opt.value
              ? 'bg-action text-on-action border-action'
              : 'bg-surface text-ink-soft border-line-strong hover:bg-surface-hover'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
