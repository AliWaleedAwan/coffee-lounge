/** The manual "Open drawer" button (step 8.7): nothing shows until a drawer is switched on. */
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { useSignedIn } from '../Shell.tsx';

export function OpenDrawer() {
  const allowed = permissionSet(useSignedIn()).has('drawer.open');
  const drawer = useQuery({
    queryKey: ['printers', 'drawer'],
    queryFn: ({ signal }) => api<{ printerId: string | null }>('/drawer', { signal }),
    enabled: allowed,
  });
  const printerId = drawer.data?.printerId ?? null;
  const open = useMutation({
    mutationFn: (id: string) =>
      api<undefined>(`/printers/${id}/drawer/open`, { method: 'POST', body: {} }),
  });
  if (!allowed || printerId === null) return null;
  return (
    <div className="row">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={open.isPending}
        onClick={() => {
          open.mutate(printerId);
        }}
      >
        Open drawer
      </button>
      {open.isError ? (
        <span role="alert" className="banner banner-danger">
          {messageOf(open.error)}
        </span>
      ) : null}
    </div>
  );
}
