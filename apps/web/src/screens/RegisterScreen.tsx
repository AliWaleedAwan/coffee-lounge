/** Device registration (API.md §4): once per device, with an 8-digit code from a manager. */
import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, messageOf } from '../api/client.ts';
import { Field } from '../components/Field.tsx';
import type { DeviceInfo } from '../auth/session.ts';

export function RegisterScreen() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const register = useMutation({
    mutationFn: (value: string) =>
      api<DeviceInfo>('/devices/register', { method: 'POST', body: { code: value } }),
    onSuccess: () => {
      void navigate('/login', { replace: true });
    },
  });
  const valid = /^\d{8}$/.test(code);
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (valid && !register.isPending) register.mutate(code);
  };

  return (
    <main className="center-screen">
      <div className="center-card card">
        <span className="brand-mark">Coffee Lounge</span>
        <h1>Register this device</h1>
        <p className="muted">
          A manager creates a one-time code on the counter PC under Devices. It works for 10
          minutes.
        </p>
        <form className="stack" onSubmit={submit} noValidate>
          <Field
            label="Registration code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ''));
            }}
            hint="8 digits"
            error={register.isError ? messageOf(register.error) : null}
          />
          <button
            type="submit"
            className="btn btn-primary btn-lg btn-block"
            disabled={!valid || register.isPending}
          >
            {register.isPending ? 'Registering…' : 'Register device'}
          </button>
        </form>
      </div>
    </main>
  );
}
