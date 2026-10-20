/**
 * Shop certificate tool (LOCAL_LAN_HOSTING.md §5, WINDOWS_DEPLOYMENT.md §6 step 4). Needs
 * no database, so the installer runs it before PostgreSQL exists.
 *
 *   create-ca      --out <dir>                    → coffee-lounge-root.pem, coffee-lounge-root.key (encrypted)
 *   issue-server   --ca-dir <dir> --out <dir> --ip 192.168.100.250 --ip 127.0.0.1 [--days 730]
 *                                                  → server.pem, server.key
 *   show           <certificate.pem>
 *
 * The CA passphrase is typed without echo, or piped by the installer (twice for create-ca).
 * Usage (from apps/server): corepack pnpm certs <command> [options]
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createRootCa, describeCertificate, issueServerCertificate } from '../platform/x509.ts';
import { lineReader } from './input.ts';

export const ROOT_CERT = 'coffee-lounge-root.pem';
export const ROOT_KEY = 'coffee-lounge-root.key';
export const SERVER_CERT = 'server.pem';
export const SERVER_KEY = 'server.key';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    'ca-dir': { type: 'string' },
    ip: { type: 'string', multiple: true },
    dns: { type: 'string', multiple: true },
    days: { type: 'string' },
  },
});

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`--${flag} is required`);
  return value;
}

/** Writes a file readable only by its owner where the OS supports it (ACLs on Windows). */
async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600, flag: 'wx' }); // never overwrite a key
  await chmod(path, 0o600).catch(() => undefined);
}

const command = positionals[0];
const input = lineReader();
try {
  if (command === 'create-ca') {
    const out = required(values.out, 'out');
    const passphrase = await input.ask('New CA passphrase (keep it with the USB key): ', true);
    const again = await input.ask('Repeat passphrase: ', true);
    if (passphrase !== again) throw new Error('Passphrases do not match');
    const ca = createRootCa({ passphrase });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, ROOT_CERT), ca.certificatePem, { flag: 'wx' });
    await writePrivate(join(out, ROOT_KEY), ca.privateKeyPem);
    const info = describeCertificate(ca.certificatePem);
    console.log(`Root CA created in ${out}: valid until ${info.validTo}`);
    console.log(`SHA-256 fingerprint: ${info.fingerprint256}`);
  } else if (command === 'issue-server') {
    const caDir = required(values['ca-dir'], 'ca-dir');
    const out = required(values.out, 'out');
    const ips = values.ip ?? [];
    if (ips.length === 0) throw new Error('--ip is required (repeat it for each address)');
    const caPassphrase = await input.ask('CA passphrase: ', true);
    const issued = issueServerCertificate({
      caCertificatePem: await readFile(join(caDir, ROOT_CERT), 'utf8'),
      caPrivateKeyPem: await readFile(join(caDir, ROOT_KEY), 'utf8'),
      caPassphrase,
      ips,
      ...(values.dns ? { dnsNames: values.dns } : {}),
      ...(values.days ? { days: Number(values.days) } : {}),
    });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, SERVER_CERT), issued.certificatePem, { flag: 'wx' });
    await writePrivate(join(out, SERVER_KEY), issued.privateKeyPem);
    const info = describeCertificate(issued.certificatePem);
    console.log(`Server certificate created in ${out} for ${info.subjectAltName ?? ''}`);
    console.log(`Valid until ${info.validTo}. Renew before then with the CA key from the USB key.`);
  } else if (command === 'show') {
    const file = required(positionals[1], 'certificate file');
    console.log(JSON.stringify(describeCertificate(await readFile(file, 'utf8')), null, 2));
  } else {
    console.log('Commands: create-ca, issue-server, show (see the header of src/cli/certs.ts)');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  input.close();
}
