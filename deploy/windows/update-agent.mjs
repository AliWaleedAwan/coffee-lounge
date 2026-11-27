// The updater (Phase 8). Windows runs it every minute as SYSTEM from a folder only
// administrators can change. It looks for a new version every hour, or at once when the owner
// presses Check now (an empty "check" file), and downloads it in the background, so that Update
// now (an empty "request" file) installs at once. Only one downloaded installer is ever kept,
// and it is removed once installed. Nothing else
// from that request is used: what gets installed comes only from a manifest signed with the
// release key, newer than this version, with a matching SHA-256. The installer itself refuses
// while bills or a shift are open, and rolls back if an upgrade fails.
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** Owner's request (Nov 2026): every hour, and at once when the owner presses Check now. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

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
  // A check that stopped the setup before it changed anything says what to do in its own words.
  const reason = /INSTALL FAILED: ([^\r\n]{1,300})/.exec(log)?.[1]?.trim();
  if (reason) return `Not updated: ${reason} Nothing was changed.`;
  return 'The update did not finish. Check that the app works, then call the technician.';
}

// ------------------------------------------------------------------ small updates (1.0.10)
// A release also lists its parts (parts.mjs), signed on their own. Only the parts whose
// fingerprint differs from what is installed are downloaded; the rest are taken from the
// installed program. The parts are put together into a full bundle, checked against the signed
// fingerprints, and installed with the same setup script, so every program file is replaced as
// with the full installer. Anything unusual uses the full installer instead.

async function partsModule() {
  return import(new URL('./parts.mjs', import.meta.url).href);
}

/** The signed parts of a manifest, or null when it has none or their signature is not valid. */
export async function verifiedParts(m, publicKeyPem) {
  if (!Array.isArray(m.parts) || typeof m.partsSignature !== 'string') return null;
  const { partsText, PART_NAMES } = await partsModule();
  for (const p of m.parts) {
    if (
      typeof p.name !== 'string' ||
      !/^[0-9a-f]{64}$/.test(p.hash) ||
      !/^[0-9a-f]{64}$/.test(p.sha256) ||
      typeof p.url !== 'string' ||
      !Number.isInteger(p.size)
    )
      return null;
  }
  const names = new Set(m.parts.map((p) => p.name));
  if (![...PART_NAMES, 'meta'].every((n) => names.has(n)) || names.size !== m.parts.length)
    return null;
  const ok = verify(
    null,
    Buffer.from(partsText(m.version, m.parts)),
    createPublicKey(publicKeyPem),
    Buffer.from(m.partsSignature, 'base64'),
  );
  return ok ? m.parts : null;
}

/** Which parts to download; null when the installed program has no record of its parts. */
export function planParts(parts, installDir) {
  let installed;
  try {
    installed = JSON.parse(readFileSync(join(installDir, 'parts.json'), 'utf8')).parts;
  } catch {
    return null;
  }
  if (!installed || typeof installed !== 'object') return null;
  return parts.map((p) => ({ ...p, download: p.name === 'meta' || installed[p.name] !== p.hash }));
}

const partsDir = (cfg) => join(cfg.agentDir, 'parts');
const archiveOf = (cfg, p) => join(partsDir(cfg), `${p.name}-${p.hash.slice(0, 16)}.part.gz`);

/** Downloads the changed parts (verified); removes every other archive. */
async function ensureParts(cfg, plan, fetchFn) {
  mkdirSync(partsDir(cfg), { recursive: true });
  const wanted = new Set(plan.filter((p) => p.download).map((p) => archiveOf(cfg, p)));
  for (const name of readdirSync(partsDir(cfg))) {
    if (!wanted.has(join(partsDir(cfg), name))) rmSync(join(partsDir(cfg), name), { force: true });
  }
  for (const p of plan.filter((x) => x.download)) {
    const file = archiveOf(cfg, p);
    if (existsSync(file)) {
      if (createHash('sha256').update(readFileSync(file)).digest('hex') === p.sha256) continue;
      rmSync(file, { force: true });
    }
    const res = await fetchFn(p.url, { signal: AbortSignal.timeout(60 * 60_000) });
    if (!res.ok) throw new Error(`download of ${p.name} answered ${String(res.status)}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== p.sha256) {
      throw new Error(`the ${p.name} part does not match its signed checksum`);
    }
    writeFileSync(`${file}.tmp`, bytes);
    renameSync(`${file}.tmp`, file);
  }
  return plan.filter((p) => p.download).reduce((sum, p) => sum + p.size, 0);
}

function removeParts(cfg) {
  rmSync(partsDir(cfg), { recursive: true, force: true });
  rmSync(join(cfg.agentDir, 'stage'), { recursive: true, force: true });
}

/** Where this install's own PostgreSQL program is, or null when it shares another one. */
function ownPgDir(cfg) {
  try {
    const db = JSON.parse(readFileSync(cfg.databaseFile, 'utf8'));
    return db.Mode === 'own' && db.PgDir ? db.PgDir : null;
  } catch {
    return null;
  }
}

/** A full bundle in agentDir/stage, every part proven against its signed fingerprint. */
export async function assembleStage(cfg, plan) {
  const { hashPart, unpack } = await partsModule();
  const stage = join(cfg.agentDir, 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const p of plan) {
    const into = p.name === 'meta' ? stage : join(stage, p.name);
    if (p.download) {
      await unpack(archiveOf(cfg, p), into);
    } else if (p.name === 'pgsql') {
      // Shared PostgreSQL: setup never uses its own copy, so an empty folder stands in.
      const pg = ownPgDir(cfg);
      if (pg) cpSync(pg, into, { recursive: true });
      else mkdirSync(into, { recursive: true });
      continue; // its fingerprint cannot be proven for a shared server, and it is not copied
    } else {
      cpSync(join(cfg.installDir, p.name), into, { recursive: true });
    }
    if (p.name !== 'meta' && hashPart(into) !== p.hash) {
      throw new Error(`the ${p.name} part is not as signed`);
    }
  }
  return stage;
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

/** The verified installer for `manifest` in agentDir, downloading it if it is not there yet. */
async function ensureDownloaded(cfg, manifest, fetchFn) {
  const file = join(cfg.agentDir, `CoffeeLounge-Setup-${manifest.version}.exe`);
  // Any other version's installer is of no use any more.
  for (const name of readdirSync(cfg.agentDir)) {
    if (/^CoffeeLounge-Setup-.*\.exe(\.tmp)?$/.test(name) && join(cfg.agentDir, name) !== file)
      rmSync(join(cfg.agentDir, name), { force: true });
  }
  if (existsSync(file)) {
    const kept = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (kept === manifest.sha256) return file;
    rmSync(file, { force: true });
  }
  const res = await fetchFn(manifest.url, { signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok) throw new Error(`download answered ${String(res.status)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('the download does not match its signed checksum');
  }
  writeFileSync(`${file}.tmp`, bytes);
  renameSync(`${file}.tmp`, file);
  return file;
}

export async function tick(cfg, deps = {}) {
  const { fetchFn = fetch, install = run, now = Date.now() } = deps;
  const statusFile = join(cfg.updateDir, 'status.json');
  const requestFile = join(cfg.updateDir, 'request');
  const checkFile = join(cfg.updateDir, 'check');
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
  const checkAsked = existsSync(checkFile);
  // An install interrupted by a power cut must not read "updating" for ever.
  if (status.state === 'updating') save({ state: 'idle' });
  save({ current });
  if (!requested && !checkAsked && now - (status.checkedAt ?? 0) < CHECK_EVERY_MS) return;

  const publicKey = readFileSync(cfg.publicKeyFile, 'utf8');
  let manifest;
  try {
    const res = await fetchFn(cfg.manifestUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`manifest answered ${String(res.status)}`);
    manifest = parseManifest(await res.text(), publicKey);
  } catch (error) {
    rmSync(checkFile, { force: true });
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
  rmSync(checkFile, { force: true });
  const newer = isNewer(manifest.version, current);
  save({ checkedAt: now, checkError: null, available: newer ? manifest.version : null });

  // In the background, so that Update now installs at once: only the changed parts when the
  // release lists them, otherwise (or if that fails) the full installer.
  let installer = null;
  let plan = null;
  if (newer) {
    try {
      const parts = await verifiedParts(manifest, publicKey);
      plan = parts ? planParts(parts, cfg.installDir) : null;
      if (plan) {
        const bytes = await ensureParts(cfg, plan, fetchFn);
        for (const name of readdirSync(cfg.agentDir)) {
          if (/^CoffeeLounge-Setup-.*\.exe(\.tmp)?$/.test(name))
            rmSync(join(cfg.agentDir, name), { force: true });
        }
        save({
          downloaded: manifest.version,
          downloadError: null,
          downloadMb: Math.ceil(bytes / 1048576),
        });
      }
    } catch {
      plan = null;
    }
    if (!plan) {
      removeParts(cfg);
      try {
        installer = await ensureDownloaded(cfg, manifest, fetchFn);
        save({ downloaded: manifest.version, downloadError: null, downloadMb: null });
      } catch (error) {
        save({ downloaded: null, downloadError: String(error.message) });
      }
    }
  } else {
    removeParts(cfg);
    // Up to date: nothing downloaded is needed.
    for (const name of readdirSync(cfg.agentDir)) {
      if (/^CoffeeLounge-Setup-.*\.exe(\.tmp)?$/.test(name))
        rmSync(join(cfg.agentDir, name), { force: true });
    }
    save({ downloaded: null, downloadError: null });
  }
  if (!requested) return;
  rmSync(requestFile, { force: true });
  if (!newer) {
    save({ state: 'idle', message: null });
    return;
  }
  const common = [
    '-Unattended',
    '-SkipHostSettings',
    ...(cfg.backupDrive ? ['-BackupDrive', cfg.backupDrive] : []),
  ];
  let stage = null;
  if (plan) {
    try {
      stage = await assembleStage(cfg, plan);
    } catch {
      // Something local is not as expected: the full installer is always right.
      removeParts(cfg);
      try {
        installer = await ensureDownloaded(cfg, manifest, fetchFn);
      } catch (error) {
        save({ downloadError: String(error.message) });
      }
    }
  }
  if (!stage && !installer) {
    save({
      state: 'failed',
      message: `The update did not start: ${String(status.downloadError ?? 'the download failed')}`,
    });
    return;
  }

  save({ state: 'updating', message: null });
  try {
    const code = stage
      ? await install(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          ),
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(stage, 'setup', 'install.ps1'),
            '-Source',
            stage,
            ...common,
          ],
        )
      : await install(installer, common);
    if (code === 0) {
      save({
        state: 'done',
        current: currentVersion(cfg.installDir),
        available: null,
        downloaded: null,
        message: null,
      });
    } else {
      save({ state: 'failed', message: failureMessage(newestInstallLog(cfg.logDir)) });
    }
  } catch (error) {
    save({ state: 'failed', message: `The update did not start: ${String(error.message)}` });
  } finally {
    if (installer) rmSync(installer, { force: true });
    removeParts(cfg);
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
