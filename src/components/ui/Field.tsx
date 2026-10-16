import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '../../lib/utils';
import { helpCls, inputCls, invalidCls, labelCls } from '../../lib/formStyles';

interface FieldShellProps {
  /** Rótulo sempre visível acima do campo (o placeholder nunca o substitui) */
  label: ReactNode;
  /** Mostra o asterisco vermelho; o campo opcional leva "(opcional)" no próprio rótulo */
  required?: boolean;
  /** Ajuda abaixo do campo */
  help?: ReactNode;
  /** Mensagem de erro (em português claro, dizendo o que corrigir) */
  error?: string | null;
  className?: string;
}

interface ShellRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

function FieldShell({
  id, label, required, help, error, className, children,
}: FieldShellProps & { id: string | undefined; children: (p: ShellRenderProps) => ReactNode }) {
  const auto = useId();
  const fieldId = id ?? auto;
  const helpId = help ? `${fieldId}-ajuda` : undefined;
  const errorId = error ? `${fieldId}-erro` : undefined;
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={fieldId} className={labelCls}>
        {label}
        {required && <span className="text-danger" aria-hidden="true"> *</span>}
      </label>
      {children({ id: fieldId, describedBy: [errorId, helpId].filter(Boolean).join(' ') || undefined, invalid: !!error })}
      {error && (
        <p id={errorId} className="mt-1.5 flex items-start gap-1.5 text-caption text-danger-ink">
          <CircleAlert className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {help && <p id={helpId} className={helpCls}>{help}</p>}
    </div>
  );
}

type FieldProps = FieldShellProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { inputClassName?: string };

/** Campo de texto com rótulo, ajuda e erro. O `id` informado é preservado (os testes localizam por ele). */
export function Field({ label, required, help, error, className, inputClassName, id, ...input }: FieldProps) {
  return (
    <FieldShell id={id} label={label} required={required} help={help} error={error} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <input
          id={fieldId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(inputCls, invalid && invalidCls, inputClassName)}
          {...input}
        />
      )}
    </FieldShell>
  );
}

type SelectProps = FieldShellProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & { children: ReactNode };

export function Select({ label, required, help, error, className, id, children, ...select }: SelectProps) {
  return (
    <FieldShell id={id} label={label} required={required} help={help} error={error} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <select
          id={fieldId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(inputCls, invalid && invalidCls)}
          {...select}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}

type TextareaProps = FieldShellProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>;

export function Textarea({ label, required, help, error, className, id, rows = 3, ...textarea }: TextareaProps) {
  return (
    <FieldShell id={id} label={label} required={required} help={help} error={error} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <textarea
          id={fieldId}
          rows={rows}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(inputCls, invalid && invalidCls)}
          {...textarea}
        />
      )}
    </FieldShell>
  );
}
