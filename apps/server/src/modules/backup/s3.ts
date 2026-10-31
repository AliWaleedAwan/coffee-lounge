/**
 * Uploads to an S3-compatible bucket (Backblaze B2, Cloudflare R2, AWS; P7-2) with AWS
 * Signature Version 4, path-style, over HTTPS only. Small and dependency-free: one PUT of an
 * object that is already encrypted.
 */
import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:https';
import type { ConnectionOptions } from 'node:tls';

export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();
const encodeKey = (key: string) =>
  key
    .split('/')
    .map((p) =>
      encodeURIComponent(p).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');

/** The Authorization header for a request (AWS SigV4, service s3). */
export function signV4(input: {
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): string {
  const date = input.amzDate.slice(0, 8);
  const headers = Object.fromEntries(
    Object.entries({ ...input.headers, host: input.host }).map(([k, v]) => [
      k.toLowerCase(),
      v.trim(),
    ]),
  );
  const names = Object.keys(headers).sort();
  const canonical = [
    input.method,
    input.path,
    '',
    ...names.map((n) => `${n}:${headers[n] ?? ''}`),
    '',
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, hex(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

/** PUTs `body` at `key`; resolves when the bucket answered 2xx. */
export function putObject(
  t: S3Target,
  key: string,
  body: Uint8Array,
  options: { at?: Date; tls?: ConnectionOptions } = {},
): Promise<void> {
  const url = new URL(t.endpoint);
  const path = `/${t.bucket}/${encodeKey(key)}`;
  const amzDate = (options.at ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const payloadHash = hex(body);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  headers['authorization'] = signV4({
    method: 'PUT',
    host: url.host,
    path,
    headers,
    payloadHash,
    amzDate,
    region: t.region,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'PUT',
        host: url.hostname,
        port: url.port || 443,
        path,
        headers,
        timeout: 120_000,
        ...options.tls,
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve();
          else
            reject(
              new Error(`the bucket answered ${String(res.statusCode)}: ${text.slice(0, 200)}`),
            );
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the bucket did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}
