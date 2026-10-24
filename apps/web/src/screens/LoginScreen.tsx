/** Password login on a registered device (API.md §4). */
import { savedBranding } from '../branding/brand.ts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, ApiError, messageOf } from '../api/client.ts';
import { Field } from '../components/Field.tsx';
import { recentUsers, startSession, type Me } from '../auth/session.ts';

export function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

export function LoginScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<Me>('/auth/login', { method: 'POST', body: { username, password } }),
    onSuccess: (me) => {
      startSession(client, me);
      void navigate(returnPath(location.state), { replace: true });
    },
    onError: (error) => {
      setPassword('');
      if (error instanceof ApiError && error.code === 'DEVICE_NOT_REGISTERED') {
        void navigate('/register', { replace: true });
      }
    },
  });
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (username && password && !login.isPending) login.mutate();
  };

  return (
    <main className="center-screen">
      <div className="center-card card">
        <span className="brand-mark">{savedBranding().shopName}</span>
        <h1>Log in</h1>
        <form className="stack" onSubmit={submit} noValidate>
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
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            error={login.isError ? messageOf(login.error) : null}
          />
          <button
            type="submit"
            className="btn btn-primary btn-lg btn-block"
            disabled={!username || !password || login.isPending}
          >
            {login.isPending ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        {recentUsers().length > 0 ? (
          <Link to="/pin" state={location.state as unknown}>
            Switch user with a PIN instead
          </Link>
        ) : null}
      </div>
    </main>
  );
}
