import { cn } from '../../lib/utils';

interface FilterChipsProps<T extends string> {
  /** `shortLabel`: rótulo abreviado para telas estreitas (o nome acessível continua sendo `label`) */
  options: { label: string; value: T; shortLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
  /** No celular, vira um controle segmentado de largura total (44px), como na lista de Encontros do design */
  segmentedOnMobile?: boolean;
}

export function FilterChips<T extends string>({ options, value, onChange, segmentedOnMobile = false }: FilterChipsProps<T>) {
  return (
    <div className={segmentedOnMobile ? 'flex md:flex-wrap md:gap-2' : 'flex gap-2 flex-wrap'}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            aria-label={opt.shortLabel ? opt.label : undefined}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center rounded-control border px-3 text-label font-medium transition-colors md:min-h-[30px]',
              segmentedOnMobile
                ? 'relative min-h-11 flex-1 justify-center rounded-none -ml-px first:ml-0 first:rounded-l-control last:rounded-r-control md:flex-none md:ml-0 md:rounded-control'
                : 'min-h-9',
              active
                ? 'z-10 bg-action text-on-action border-action'
                : 'bg-surface text-ink-soft border-line-strong hover:bg-surface-hover'
            )}
          >
            {opt.shortLabel ? (
              <>
                <span className="sm:hidden" aria-hidden="true">{opt.shortLabel}</span>
                <span className="hidden sm:inline" aria-hidden="true">{opt.label}</span>
              </>
            ) : (
              opt.label
            )}
          </button>
        );
      })}
    </div>
  );
}
