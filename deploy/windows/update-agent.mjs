// The updater (Phase 8). Windows runs it every minute as SYSTEM from a folder only
// administrators can change. It looks for a new version every 6 hours and installs one only
// when the owner pressed Update now, which leaves an empty request file behind. Nothing else
// from that request is used: what gets installed comes only from a manifest signed with the
// release key, newer than this version, with a matching SHA-256. The installer itself refuses
// while bills or a shift are open, and rolls back if an upgrade fails.
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function isNewer(candidate, current) {
  const parts = (v) => {
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`bad version ${v}`);
    return v.split('.').map(Number);
  };
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The exact text the release key signs. */
export function signedText(m) {
  return `coffee-lounge-update\n${m.version}\n${m.url}\n${m.sha256}\n`;
}

/** The manifest, once its signature is proven; throws otherwise. */
export function parseManifest(text, publicKeyPem) {
  const m = JSON.parse(text);
  for (const key of ['version', 'url', 'sha256', 'signature']) {
    if (typeof m[key] !== 'string') throw new Error(`manifest has no ${key}`);
  }
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error('manifest sha256 is malformed');
  const ok = verify(
    null,
    Buffer.from(signedText(m)),
    createPublicKey(publicKeyPem),
    Buffer.from(m.signature, 'base64'),
  );
  if (!ok) throw new Error('manifest signature is not valid');
  isNewer(m.version, '0.0.0'); // the version must be well formed
  return m;
}

export function currentVersion(installDir) {
  const line = readFileSync(join(installDir, 'VERSION.txt'), 'utf8').split(/\r?\n/)[0] ?? '';
  const match = /^Coffee Lounge (\d+\.\d+\.\d+)/.exec(line);
  if (!match) throw new Error(`cannot read the version from: ${line}`);
  return match[1];
}

/** What to tell the owner about a failed install, from the end of its log. */
export function failureMessage(log) {
  if (log.includes('Upgrade refused')) {
    return 'Not updated: bills or a cash shift are open. Close them, then press Update now again.';
  }
  if (log.includes('ROLLED BACK')) {
    return 'The update failed, so the previous version and data were put back. Call the technician.';
  }
  return 'The update did not finish. Check that the app works, then call the technician.';
}

function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {
      resolve(-1);
    });
    child.on('close', (code) => {
      resolve(code ?? -1);
    });
  });
}

export async function tick(cfg, deps = {}) {
  const { fetchFn = fetch, install = run, now = Date.now() } = deps;
  const statusFile = join(cfg.updateDir, 'status.json');
  const requestFile = join(cfg.updateDir, 'request');
  let status = {};
  try {
    status = JSON.parse(readFileSync(statusFile, 'utf8'));
  } catch {
    // first run
  }
  const save = (changes) => {
    status = { ...status, ...changes };
    writeFileSync(`${statusFile}.tmp`, JSON.stringify(status));
    renameSync(`${statusFile}.tmp`, statusFile);
  };
  const current = currentVersion(cfg.installDir);
  const requested = existsSync(requestFile);
  // An install interrupted by a power cut must not read "updating" for ever.
  if (status.state === 'updating') save({ state: 'idle' });
  save({ current });
  if (!requested && now - (status.checkedAt ?? 0) < CHECK_EVERY_MS) return;

  const publicKey = readFileSync(cfg.publicKeyFile, 'utf8');
  let manifest;
  try {
    const res = await fetchFn(cfg.manifestUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`manifest answered ${String(res.status)}`);
    manifest = parseManifest(await res.text(), publicKey);
  } catch (error) {
    if (requested) {
      rmSync(requestFile, { force: true });
      save({
        state: 'failed',
        message: 'Could not reach the update site, or its answer was not trusted. Try again later.',
      });
    }
    save({ checkedAt: now, checkError: String(error.message) });
    return;
  }
  const newer = isNewer(manifest.version, current);
  save({ checkedAt: now, checkError: null, available: newer ? manifest.version : null });
  if (!requested) return;
  rmSync(requestFile, { force: true });
  if (!newer) {
    save({ state: 'idle', message: null });
    return;
  }

  save({ state: 'updating', message: null });
  const installer = join(cfg.agentDir, `CoffeeLounge-Setup-${manifest.version}.exe`);
  try {
    const res = await fetchFn(manifest.url, { signal: AbortSignal.timeout(60 * 60_000) });
    if (!res.ok) throw new Error(`download answered ${String(res.status)}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
      throw new Error('the download does not match its signed checksum');
    }
    writeFileSync(installer, bytes);
    const code = await install(installer, [
      '-Unattended',
      '-SkipHostSettings',
      ...(cfg.backupDrive ? ['-BackupDrive', cfg.backupDrive] : []),
    ]);
    if (code === 0) {
      save({
        state: 'done',
        current: currentVersion(cfg.installDir),
        available: null,
        message: null,
      });
    } else {
      save({ state: 'failed', message: failureMessage(newestInstallLog(cfg.logDir)) });
    }
  } catch (error) {
    save({ state: 'failed', message: `The update did not start: ${String(error.message)}` });
  } finally {
    rmSync(installer, { force: true });
  }
}

function newestInstallLog(logDir) {
  try {
    const names = readdirSync(logDir).filter((n) => n.startsWith('install-'));
    names.sort((a, b) => statSync(join(logDir, a)).mtimeMs - statSync(join(logDir, b)).mtimeMs);
    const last = names.at(-1);
    return last ? readFileSync(join(logDir, last), 'utf8') : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  await tick(cfg);
}
