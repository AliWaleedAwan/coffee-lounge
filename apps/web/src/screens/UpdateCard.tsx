/**
 * Updates on the health page: only the owner sees it, and only on an installed shop. The
 * updater looks every hour, or at once with Check now, and downloads a new version in the
 * background, so Update now installs at once.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, messageOf } from '../api/client.ts';
import { permissionSet } from '../auth/session.ts';
import { useSignedIn } from './Shell.tsx';

interface UpdateStatus {
  supported: boolean;
  current: string | null;
  available: string | null;
  /** The version already downloaded and checked, ready to install. */
  downloaded: string | null;
  checkedAt: string | null;
  checking: boolean;
  checkError: string | null;
  state: 'idle' | 'requested' | 'updating' | 'done' | 'failed';
  message: string | null;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

export function UpdateCard() {
  const allowed = permissionSet(useSignedIn()).has('system.update');
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['system', 'update'],
    queryFn: ({ signal }) => api<UpdateStatus>('/system/update', { signal }),
    enabled: allowed,
    refetchInterval: 10_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['system', 'update'] });
  const start = useMutation({
    mutationFn: () => api<undefined>('/system/update', { method: 'POST', body: {} }),
    onSettled: refresh,
  });
  const check = useMutation({
    mutationFn: () => api<undefined>('/system/update/check', { method: 'POST', body: {} }),
    onSettled: refresh,
  });
  const s = status.data;
  if (!allowed || !s?.supported) return null;
  const busy = s.state === 'requested' || s.state === 'updating';
  const ready = s.available !== null && s.downloaded === s.available;
  return (
    <section className="card stack" aria-labelledby="updates">
      <h2 id="updates">Updates</h2>
      <p>
        This PC runs version {s.current ?? 'unknown'}.
        {s.checkedAt ? <span className="muted"> Last checked {when(s.checkedAt)}.</span> : null}
      </p>
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
            Version {s.available}{' '}
            {ready
              ? 'is downloaded and ready to install.'
              : 'is available; it is downloading in the background.'}{' '}
            Update outside trading hours: every device stops for a few minutes, and it will not
            start while bills or a cash shift are open.
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
      {s.checkError && !busy ? (
        <p className="muted">The last check could not reach the update site. It tries again.</p>
      ) : null}
      {!busy ? (
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={check.isPending || s.checking}
            onClick={() => {
              check.mutate();
            }}
          >
            {s.checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      ) : null}
      {start.isError || check.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(start.error ?? check.error)}
        </div>
      ) : null}
    </section>
  );
}
