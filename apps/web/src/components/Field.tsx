import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/** A labelled input with hint and inline error (UI_UX.md §5, §9). */
export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint ? (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface SelectFieldProps {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function SelectField({ label, value, options, onChange, disabled }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  rows?: number;
  maxLength?: number;
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  rows = 3,
  maxLength,
}: TextAreaFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        maxLength={maxLength}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      {hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A checkbox with its label; large enough to tap (UI_UX.md §5). */
export function CheckField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      {label}
    </label>
  );
}
