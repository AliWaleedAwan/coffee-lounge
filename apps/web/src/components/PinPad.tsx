/**
 * PIN pad (UI_UX.md §5): 64 px keys, dots instead of digits, physical keyboard support
 * on the counter PC. The PIN never leaves this component except through onSubmit.
 */
import { useState, type KeyboardEvent } from 'react';

export interface PinPadProps {
  /** Accessible name, e.g. "PIN for Sara". */
  label: string;
  minLength?: number;
  maxLength?: number;
  disabled?: boolean;
  submitLabel?: string;
  onSubmit: (pin: string) => void;
  /** Changing this clears the entered digits (e.g. after a wrong PIN). */
  resetKey?: unknown;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function PinPad({
  label,
  minLength = 4,
  maxLength = 6,
  disabled = false,
  submitLabel = 'Enter',
  onSubmit,
  resetKey,
}: PinPadProps) {
  // Digits belong to the resetKey they were typed under; a new key starts empty.
  const [entry, setEntry] = useState<{ key: unknown; pin: string }>({ key: resetKey, pin: '' });
  const pin = Object.is(entry.key, resetKey) ? entry.pin : '';
  const setPin = (update: (current: string) => string): void => {
    setEntry((e) => ({ key: resetKey, pin: update(Object.is(e.key, resetKey) ? e.pin : '') }));
  };

  const add = (digit: string): void => {
    if (!disabled) setPin((p) => (p.length < maxLength ? p + digit : p));
  };
  const back = (): void => {
    setPin((p) => p.slice(0, -1));
  };
  const submit = (): void => {
    if (!disabled && pin.length >= minLength) onSubmit(pin);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (/^\d$/.test(event.key)) add(event.key);
    else if (event.key === 'Backspace') back();
    else if (event.key === 'Enter') submit();
    else return;
    event.preventDefault();
  };

  return (
    <div className="stack" role="group" aria-label={label} tabIndex={0} onKeyDown={onKeyDown}>
      <div
        className="pin-dots"
        role="status"
        aria-label={`${pin.length} of up to ${maxLength} digits entered`}
      >
        {Array.from({ length: Math.max(minLength, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? 'pin-dot pin-dot-filled' : 'pin-dot'} />
        ))}
      </div>
      <div className="pin-pad">
        {KEYS.map((digit) => (
          <button
            key={digit}
            type="button"
            className="pin-key"
            disabled={disabled}
            onClick={() => {
              add(digit);
            }}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          className="pin-key"
          aria-label="Delete last digit"
          disabled={disabled || pin.length === 0}
          onClick={back}
        >
          ⌫
        </button>
        <button
          type="button"
          className="pin-key"
          disabled={disabled}
          onClick={() => {
            add('0');
          }}
        >
          0
        </button>
        <button
          type="button"
          className="pin-key"
          disabled={disabled || pin.length < minLength}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
