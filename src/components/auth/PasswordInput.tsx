import { useState, type Ref } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fieldCls, fieldIconCls, fieldInvalidCls, fieldWithIconCls, labelCls } from '../../lib/authStyles';

interface PasswordInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  name?: string;
  /** Texto de apoio dentro do campo vazio (nunca substitui o rótulo). */
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  readOnly?: boolean;
  /** Ref do <input>, para mover o foco ao campo inválido após um erro. */
  inputRef?: Ref<HTMLInputElement>;
}

/** Campo de senha com ícone, placeholder e botão mostrar/ocultar acessível. */
export function PasswordInput({
  id, label, value, onChange, autoComplete, name, placeholder, invalid, describedBy, readOnly, inputRef,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      <div className="relative mt-1.5">
        <LockKeyhole className={fieldIconCls} aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          type={visible ? 'text' : 'password'}
          name={name}
          required
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(fieldCls, fieldWithIconCls, 'pr-11', invalid && fieldInvalidCls)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-control text-ink-faint transition-colors hover:text-ink focus-visible:-outline-offset-2"
        >
          {visible ? <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" /> : <Eye className="h-[18px] w-[18px]" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
