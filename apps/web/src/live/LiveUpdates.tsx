/** Runs the live-update stream while a user is signed in and turns hints into refetches. */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { API_BASE } from '../api/client.ts';
import { ME_KEY } from '../auth/session.ts';
import { connection } from '../connection/store.ts';
import { invalidateAll, invalidateForHint } from './invalidate.ts';
import { LiveClient } from './live-client.ts';

export function LiveUpdates() {
  const client = useQueryClient();
  useEffect(() => {
    const live = new LiveClient({
      url: `${API_BASE}/events`,
      onHint: (hint) => void invalidateForHint(client, hint.topics),
      onResync: () => void invalidateAll(client),
      onOpen: () => {
        connection.report({ type: 'stream_open' });
      },
      onLost: () => {
        connection.report({ type: 'stream_lost' });
      },
      // Session ended or device revoked: re-read /auth/me, which sends the user to
      // the PIN, login or registration screen.
      onRefused: () => {
        connection.report({ type: 'stream_stopped' });
        void client.invalidateQueries({ queryKey: ME_KEY });
      },
    });
    live.start();
    return () => {
      live.stop();
      connection.report({ type: 'stream_stopped' });
    };
  }, [client]);
  return null;
}
