import { CircleAlert, CircleCheck, Info } from 'lucide-react';

type Tone = 'error' | 'success' | 'info';

const TONES: Record<Tone, { cls: string; icon: React.ElementType }> = {
  error: { cls: 'border-red-200 bg-red-50 text-red-700', icon: CircleAlert },
  success: { cls: 'border-green-200 bg-green-50 text-green-700', icon: CircleCheck },
  info: { cls: 'border-blue-200 bg-blue-50 text-blue-700', icon: Info },
};

/** Mensagem das telas de auth. Erros usam role="alert" (anunciado na hora); o resto, role="status". */
export function AuthAlert({ tone, id, children }: { tone: Tone; id?: string; children: React.ReactNode }) {
  const { cls, icon: Icon } = TONES[tone];
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${cls}`}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
