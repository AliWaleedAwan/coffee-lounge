/** My account: change password (forced after a reset) and set the PIN used to switch users. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, messageOf } from '../api/client.ts';
import { ME_KEY } from '../auth/session.ts';
import { Field } from '../components/Field.tsx';
import { useWritesAllowed } from '../connection/ConnectionBanner.tsx';
import { useSignedIn } from './Shell.tsx';

function PasswordForm() {
  const client = useQueryClient();
  const writes = useWritesAllowed();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [repeat, setRepeat] = useState('');
  const change = useMutation({
    mutationFn: () =>
      api<undefined>('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
    onSuccess: () => {
      setCurrent('');
      setNew('');
      setRepeat('');
      void client.invalidateQueries({ queryKey: ME_KEY });
    },
  });
  const mismatch = repeat.length > 0 && repeat !== newPassword;
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (currentPassword && newPassword && !mismatch && writes) change.mutate();
  };
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="pw-title">
      <h2 id="pw-title">Change password</h2>
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => {
          setCurrent(e.target.value);
        }}
      />
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        hint="At least 10 characters."
        value={newPassword}
        onChange={(e) => {
          setNew(e.target.value);
        }}
      />
      <Field
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => {
          setRepeat(e.target.value);
        }}
        error={mismatch ? 'The two new passwords are different.' : null}
      />
      {change.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(change.error)}
        </div>
      ) : null}
      {change.isSuccess ? (
        <div role="status" className="banner banner-success">
          Password changed.
        </div>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!currentPassword || !newPassword || mismatch || !writes || change.isPending}
        >
          {change.isPending ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

function PinForm() {
  const writes = useWritesAllowed();
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const save = useMutation({
    mutationFn: () => api<undefined>('/auth/pin', { method: 'POST', body: { password, pin } }),
    onSuccess: () => {
      setPassword('');
      setPin('');
    },
  });
  const validPin = /^\d{4,6}$/.test(pin);
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (password && validPin && writes) save.mutate();
  };
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="pin-title">
      <h2 id="pin-title">PIN for switching users</h2>
      <p className="muted">With a PIN you can take over a shared device without your password.</p>
      <Field
        label="Your password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
      />
      <Field
        label="New PIN"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        hint="4 to 6 digits. Avoid 1234 or your birthday."
        value={pin}
        onChange={(e) => {
          setPin(e.target.value.replace(/\D/g, ''));
        }}
      />
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
      {save.isSuccess ? (
        <div role="status" className="banner banner-success">
          PIN saved.
        </div>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!password || !validPin || !writes || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save PIN'}
        </button>
      </div>
    </form>
  );
}

export function AccountScreen() {
  const me = useSignedIn();
  return (
    <>
      <h1>My account</h1>
      {me.mustChangePassword ? (
        <div role="alert" className="banner banner-warning">
          Your password was reset. Choose a new one before you continue.
        </div>
      ) : null}
      <dl className="kv card">
        <dt>Name</dt>
        <dd>{me.user.name}</dd>
        <dt>Username</dt>
        <dd>{me.user.username}</dd>
        <dt>Device</dt>
        <dd>{me.device.name}</dd>
      </dl>
      <PasswordForm />
      {me.mustChangePassword ? null : <PinForm />}
    </>
  );
}
