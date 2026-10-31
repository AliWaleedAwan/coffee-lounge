/**
 * The off-site copy (D-23; P7-2; Phase 7 step 7.2): the owner's S3-compatible bucket (for
 * example Backblaze B2 or Cloudflare R2) that the newest encrypted backup goes to each day.
 * The secret key is typed once, sealed on the server and never shown again; "Test" shows the
 * bucket's own answer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { Field } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';

interface Offsite {
  configured: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretSet?: boolean;
  version?: number;
  last: { at: string; status: string; error: string | null } | null;
}

export function OffsiteForm() {
  const q = useQuery({
    queryKey: ['backup', 'offsite'],
    queryFn: ({ signal }) => api<Offsite>('/backup/offsite', { signal }),
  });
  if (q.isError)
    return (
      <div role="alert" className="banner banner-danger">
        {messageOf(q.error)}
      </div>
    );
  if (!q.data) return <Loading label="Loading the off-site copy" />;
  return <Form saved={q.data} />;
}

function Form({ saved }: { saved: Offsite }) {
  const writes = useWritesAllowed();
  const client = useQueryClient();
  const [form, setForm] = useState({
    endpoint: saved.endpoint ?? 'https://',
    region: saved.region ?? 'auto',
    bucket: saved.bucket ?? '',
    prefix: saved.prefix ?? 'coffee-lounge/',
    accessKeyId: saved.accessKeyId ?? '',
    secretAccessKey: '',
  });
  const save = useMutation({
    mutationFn: () =>
      api<Offsite>('/backup/offsite', {
        method: 'PUT',
        body: {
          endpoint: form.endpoint.trim(),
          region: form.region.trim(),
          bucket: form.bucket.trim(),
          prefix: form.prefix.trim(),
          accessKeyId: form.accessKeyId.trim(),
          ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}),
          ...(saved.version !== undefined ? { expectedVersion: saved.version } : {}),
        },
      }),
    onSuccess: async () => {
      setForm((f) => ({ ...f, secretAccessKey: '' }));
      await client.invalidateQueries({ queryKey: ['backup', 'offsite'] });
    },
  });
  const test = useMutation({
    mutationFn: () => api('/backup/offsite/test', { method: 'POST' }),
  });
  const field = (key: keyof typeof form, label: string, extra: object = {}) => (
    <Field
      label={label}
      value={form[key]}
      {...extra}
      onChange={(e) => {
        save.reset();
        test.reset();
        setForm({ ...form, [key]: e.target.value });
      }}
    />
  );
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (writes) save.mutate();
  };
  return (
    <form className="card stack" noValidate onSubmit={submit} aria-labelledby="offsite">
      <h2 id="offsite">Off-site copy of the backups</h2>
      <p className="muted">
        Each day the newest backup, already encrypted, is copied to your own storage bucket, so a
        fire or theft at the shop loses at most a day. Without internet it waits. Create the bucket
        and a key that may only write to it at your provider, then type them here.
      </p>
      <div className="row">
        {field('endpoint', 'Endpoint')}
        {field('region', 'Region')}
      </div>
      <div className="row">
        {field('bucket', 'Bucket')}
        {field('prefix', 'Folder in the bucket')}
      </div>
      <div className="row">
        {field('accessKeyId', 'Key ID', { autoComplete: 'off' })}
        {field('secretAccessKey', 'Secret key', {
          type: 'password',
          autoComplete: 'new-password',
          hint: saved.secretSet ? 'Saved. Leave empty to keep it.' : undefined,
        })}
      </div>
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
      {test.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(test.error)}
        </div>
      ) : null}
      {test.isSuccess ? (
        <p role="status" className="banner banner-success">
          The bucket accepted a test file.
        </p>
      ) : null}
      {saved.last ? (
        <p className="muted">
          Last copy: {new Date(saved.last.at).toLocaleString('en-GB')} ·{' '}
          {saved.last.status === 'succeeded' ? 'copied' : `waiting (${saved.last.error ?? ''})`}
        </p>
      ) : null}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!writes || save.isPending || (!saved.configured && !form.secretAccessKey)}
        >
          Save
        </button>
        {saved.configured ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes || test.isPending}
            onClick={() => {
              test.mutate();
            }}
          >
            Test
          </button>
        ) : null}
      </div>
    </form>
  );
}
