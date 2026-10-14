import { CircleAlert, CircleCheck, Info } from 'lucide-react';

type Tone = 'error' | 'success' | 'info';

const TONES: Record<Tone, { cls: string; icon: React.ElementType }> = {
  error: { cls: 'border-danger-line bg-danger-soft text-danger-ink', icon: CircleAlert },
  success: { cls: 'border-success-line bg-success-soft text-success-ink', icon: CircleCheck },
  info: { cls: 'border-action-line bg-action-soft text-action-ink', icon: Info },
};

/** Mensagem das telas de auth. Erros usam role="alert" (anunciado na hora); o resto, role="status". */
export function AuthAlert({ tone, id, children }: { tone: Tone; id?: string; children: React.ReactNode }) {
  const { cls, icon: Icon } = TONES[tone];
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-control border px-3.5 py-2.5 text-table ${cls}`}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
