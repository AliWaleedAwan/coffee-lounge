/**
 * PIN switch (UI_UX.md §1: fast user switching on the counter PC; waiter devices).
 * Recent users on this device are shown as tiles; anyone else types a username.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, ApiError, messageOf } from '../api/client.ts';
import { Field } from '../components/Field.tsx';
import { PinPad } from '../components/PinPad.tsx';
import { recentUsers, startSession, type Me } from '../auth/session.ts';
import { returnPath } from './LoginScreen.tsx';

export function PinScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const recent = recentUsers();
  const [username, setUsername] = useState(recent[0]?.username ?? '');
  const [other, setOther] = useState(recent.length === 0);
  const [attempt, setAttempt] = useState(0);
  const pinSwitch = useMutation({
    mutationFn: (pin: string) =>
      api<Me>('/auth/pin-switch', { method: 'POST', body: { username, pin } }),
    onSuccess: (me) => {
      startSession(client, me);
      void navigate(returnPath(location.state), { replace: true });
    },
    onError: (error) => {
      setAttempt((n) => n + 1);
      if (error instanceof ApiError && error.code === 'DEVICE_NOT_REGISTERED') {
        void navigate('/register', { replace: true });
      }
    },
  });
  const selected = recent.find((u) => u.username === username);

  return (
    <main className="center-screen">
      <div className="center-card card">
        <span className="brand-mark">Coffee Lounge</span>
        <h1>Who is using this device?</h1>
        {recent.length > 0 ? (
          <div className="user-tiles" role="group" aria-label="Recent users">
            {recent.map((u) => (
              <button
                key={u.username}
                type="button"
                className="btn btn-secondary user-tile"
                aria-pressed={!other && u.username === username}
                onClick={() => {
                  setOther(false);
                  setUsername(u.username);
                  pinSwitch.reset();
                }}
              >
                {u.name}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-ghost user-tile"
              aria-pressed={other}
              onClick={() => {
                setOther(true);
                setUsername('');
                pinSwitch.reset();
              }}
            >
              Someone else
            </button>
          </div>
        ) : null}
        {other ? (
          <Field
            label="Username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value.trim());
            }}
          />
        ) : null}
        {pinSwitch.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(pinSwitch.error)}
          </div>
        ) : null}
        <PinPad
          label={`PIN for ${selected?.name ?? (username || 'user')}`}
          disabled={username.length < 2 || pinSwitch.isPending}
          submitLabel={pinSwitch.isPending ? '…' : 'Enter'}
          resetKey={`${username}:${String(attempt)}`}
          onSubmit={(pin) => {
            pinSwitch.mutate(pin);
          }}
        />
        <Link to="/login" state={location.state as unknown}>
          Log in with a password instead
        </Link>
      </div>
    </main>
  );
}
