/** "Update now" on the health page: only the owner sees it, and only on an installed shop. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, messageOf } from '../api/client.ts';
import { permissionSet } from '../auth/session.ts';
import { useSignedIn } from './Shell.tsx';

interface UpdateStatus {
  supported: boolean;
  current: string | null;
  available: string | null;
  state: 'idle' | 'requested' | 'updating' | 'done' | 'failed';
  message: string | null;
}

export function UpdateCard() {
  const allowed = permissionSet(useSignedIn()).has('system.update');
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['system', 'update'],
    queryFn: ({ signal }) => api<UpdateStatus>('/system/update', { signal }),
    enabled: allowed,
    refetchInterval: 15_000,
  });
  const start = useMutation({
    mutationFn: () => api<undefined>('/system/update', { method: 'POST', body: {} }),
    onSettled: () => client.invalidateQueries({ queryKey: ['system', 'update'] }),
  });
  const s = status.data;
  if (!allowed || !s?.supported) return null;
  const busy = s.state === 'requested' || s.state === 'updating';
  return (
    <section className="card stack" aria-labelledby="updates">
      <h2 id="updates">Updates</h2>
      <p>This PC runs version {s.current ?? 'unknown'}.</p>
      {s.state === 'failed' && s.message ? (
        <div role="alert" className="banner banner-danger">
          {s.message}
        </div>
      ) : null}
      {s.state === 'done' ? (
        <div role="status" className="banner banner-success">
          Updated.
        </div>
      ) : null}
      {busy ? (
        <div role="status" className="banner banner-warning">
          Updating. The app stops for a few minutes and comes back by itself.
        </div>
      ) : null}
      {s.available && !busy ? (
        <>
          <p>
            Version {s.available} is ready. Update outside trading hours: every device stops for a
            few minutes, and it will not start while bills or a cash shift are open.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={start.isPending}
              onClick={() => {
                start.mutate();
              }}
            >
              Update now
            </button>
          </div>
        </>
      ) : null}
      {!s.available && !busy && s.state !== 'failed' ? <p className="muted">Up to date.</p> : null}
      {start.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(start.error)}
        </div>
      ) : null}
    </section>
  );
}
