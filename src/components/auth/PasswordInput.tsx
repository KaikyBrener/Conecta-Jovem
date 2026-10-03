import { useState, type Ref } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fieldCls, fieldInvalidCls, labelCls } from '../../lib/authStyles';

interface PasswordInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  name?: string;
  invalid?: boolean;
  describedBy?: string;
  readOnly?: boolean;
  /** Ref do <input>, para mover o foco ao campo inválido após um erro. */
  inputRef?: Ref<HTMLInputElement>;
}

/** Campo de senha com botão mostrar/ocultar acessível. */
export function PasswordInput({
  id, label, value, onChange, autoComplete, name, invalid, describedBy, readOnly, inputRef,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      <div className="relative mt-1.5">
        <input
          ref={inputRef}
          id={id}
          type={visible ? 'text' : 'password'}
          name={name}
          required
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(fieldCls, 'pr-12', invalid && fieldInvalidCls)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-gray-500 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        >
          {visible ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
