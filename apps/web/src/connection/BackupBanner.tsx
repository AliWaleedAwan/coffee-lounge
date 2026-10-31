/**
 * The backup banner on every device (BACKUP_RECOVERY.md §3, §8; AT-80; step 7.1): the backup
 * drive missing for 5 minutes, archiving failing, last night's backup failed or overdue.
 * Asked every minute; nothing shows while all is well, or where backups are not set up.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api/client.ts';

interface BackupStatus {
  problem: string | null;
  message: string | null;
  since: string | null;
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function BackupBanner({ canSeeHealth }: { canSeeHealth: boolean }) {
  const status = useQuery({
    queryKey: ['system', 'backup-status'],
    queryFn: ({ signal }) => api<BackupStatus>('/system/backup-status', { signal }),
    refetchInterval: 60_000,
    retry: false,
  });
  const s = status.data;
  if (!s?.problem || !s.message) return null;
  return (
    <div role="alert" className="banner banner-danger">
      <strong>{s.message}</strong>
      {s.since ? <> Since {timeFormat.format(new Date(s.since))}.</> : null}{' '}
      {canSeeHealth ? (
        <Link to="/system-health">Open System health</Link>
      ) : (
        'Tell the owner or manager.'
      )}
    </div>
  );
}
