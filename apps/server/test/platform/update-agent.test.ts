/** The updater (deploy/windows/update-agent.mjs): only a signed, newer, intact file installs. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  failureMessage,
  isNewer,
  signedText,
  tick,
} from '../../../../deploy/windows/update-agent.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519').privateKey;
const INSTALLER = Buffer.from('the real installer');

function manifest(version: string, key = privateKey, body = INSTALLER) {
  const m = {
    version,
    url: 'https://example.test/setup.exe',
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  return JSON.stringify({
    ...m,
    signature: sign(null, Buffer.from(signedText(m)), key).toString('base64'),
  });
}

let dir: string;
let cfg: Record<string, string>;
let installs: string[][];
const status = () =>
  JSON.parse(readFileSync(join(cfg['updateDir'] ?? '', 'status.json'), 'utf8')) as Record<
    string,
    unknown
  >;
const request = () => {
  writeFileSync(join(cfg['updateDir'] ?? '', 'request'), '');
};

function go(text: string, options: { code?: number; body?: Buffer; now?: number } = {}) {
  const fetchFn = (url: string) =>
    Promise.resolve(
      url === cfg['manifestUrl']
        ? new Response(text)
        : new Response(new Uint8Array(options.body ?? INSTALLER)),
    );
  return tick(cfg, {
    fetchFn,
    now: options.now ?? 1e12,
    install: (file: string, args: string[]) => {
      installs.push([file, ...args]);
      return Promise.resolve(options.code ?? 0);
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-update-'));
  installs = [];
  for (const d of ['install', 'update', 'agent', 'logs']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'install', 'VERSION.txt'), 'Coffee Lounge 1.2.3 (abc)\r\nnode 24\r\n');
  const publicKeyFile = join(dir, 'agent', 'public.pem');
  writeFileSync(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  cfg = {
    manifestUrl: 'https://example.test/latest.json',
    publicKeyFile,
    installDir: join(dir, 'install'),
    updateDir: join(dir, 'update'),
    agentDir: join(dir, 'agent'),
    logDir: join(dir, 'logs'),
    backupDrive: 'B:\\',
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the updater', () => {
  it('compares versions as numbers', () => {
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.2.2', '1.2.3')).toBe(false);
    expect(() => isNewer('1.2', '1.2.3')).toThrow();
  });

  it('only reports a new version until the owner asks: nothing installs by itself', async () => {
    await go(manifest('1.3.0'));
    expect(status()).toMatchObject({ current: '1.2.3', available: '1.3.0' });
    expect(installs).toEqual([]);
  });

  it('installs when asked, keeps the backup drive, and removes the request and the file', async () => {
    request();
    await go(manifest('1.3.0'));
    expect(installs).toHaveLength(1);
    expect(installs[0]?.slice(1)).toEqual([
      '-Unattended',
      '-SkipHostSettings',
      '-BackupDrive',
      'B:\\',
    ]);
    expect(status()).toMatchObject({ state: 'done' });
    expect(existsSync(join(cfg['updateDir'] ?? '', 'request'))).toBe(false);
    expect(existsSync(installs[0]?.[0] ?? '')).toBe(false);
  });

  it('refuses a manifest signed by anyone else', async () => {
    request();
    await go(manifest('1.3.0', stranger));
    expect(installs).toEqual([]);
    expect(status()).toMatchObject({ state: 'failed' });
  });

  it('refuses a download that does not match the signed checksum', async () => {
    request();
    await go(manifest('1.3.0'), { body: Buffer.from('something else') });
    expect(installs).toEqual([]);
    expect(status()).toMatchObject({ state: 'failed' });
  });

  it('never goes back to an older version, even when asked and properly signed', async () => {
    request();
    await go(manifest('1.2.0'));
    expect(installs).toEqual([]);
    expect(status()).toMatchObject({ available: null });
  });

  it('looks only every 6 hours, unless asked', async () => {
    await go(manifest('1.3.0'));
    await go('not looked at', { now: 1e12 + 1000 });
    expect(status()).toMatchObject({ available: '1.3.0', checkError: null });
  });

  it('a request after a refused install says why, in plain words', async () => {
    writeFileSync(join(dir, 'logs', 'install-1.log'), 'INSTALL FAILED: Upgrade refused: 1 open');
    request();
    await go(manifest('1.3.0'), { code: 1 });
    expect(String(status()['message'])).toMatch(/bills or a cash shift are open/);
    expect(failureMessage('ROLLED BACK: x')).toMatch(/put back/);
    // Seen on a real laptop: the setup's own reason reaches the owner, not "did not finish".
    expect(
      failureMessage(
        '[2026-11-12 23:57:13] INSTALL FAILED: Not enough free disk space: 10 GB is needed, 8 GB is free. Free up space on drive C: and try again.\nAt C:\\x.ps1:112',
      ),
    ).toBe(
      'Not updated: Not enough free disk space: 10 GB is needed, 8 GB is free. Free up space on drive C: and try again. Nothing was changed.',
    );
    expect(failureMessage('something else')).toMatch(/did not finish/);
  });
});

describe('downloads in the background, checks on demand (owner, Nov 2026)', () => {
  const downloads = () => {
    let n = 0;
    const fetchFn = (url: string) => {
      if (url !== cfg['manifestUrl']) n += 1;
      return Promise.resolve(
        url === cfg['manifestUrl']
          ? new Response(manifest('1.3.0'))
          : new Response(new Uint8Array(INSTALLER)),
      );
    };
    return { fetchFn, count: () => n };
  };
  const ticks = (fetchFn: (url: string) => Promise<Response>, now: number) =>
    tick(cfg, {
      fetchFn,
      now,
      install: (file: string, args: string[]) => {
        installs.push([file, ...args]);
        return Promise.resolve(0);
      },
    });

  it('downloads a new version as soon as it is found, without installing it', async () => {
    const d = downloads();
    await ticks(d.fetchFn, 1e12);
    expect(d.count()).toBe(1);
    expect(installs).toEqual([]);
    expect(status()).toMatchObject({ available: '1.3.0', downloaded: '1.3.0' });
    expect(existsSync(join(cfg['agentDir'] ?? '', 'CoffeeLounge-Setup-1.3.0.exe'))).toBe(true);
  });

  it('Update now installs the file already downloaded, without downloading again, then removes it', async () => {
    const d = downloads();
    await ticks(d.fetchFn, 1e12);
    request();
    await ticks(d.fetchFn, 1e12 + 60_000);
    expect(d.count()).toBe(1);
    expect(installs).toHaveLength(1);
    expect(readdirSync(cfg['agentDir'] ?? '').filter((n) => n.endsWith('.exe'))).toEqual([]);
  });

  it('checks every hour, and at once when asked', async () => {
    const d = downloads();
    await ticks(d.fetchFn, 1e12);
    const checked = status()['checkedAt'];
    await ticks(d.fetchFn, 1e12 + 30 * 60_000);
    expect(status()['checkedAt']).toBe(checked);
    writeFileSync(join(cfg['updateDir'] ?? '', 'check'), '');
    await ticks(d.fetchFn, 1e12 + 31 * 60_000);
    expect(status()['checkedAt']).toBe(1e12 + 31 * 60_000);
    expect(existsSync(join(cfg['updateDir'] ?? '', 'check'))).toBe(false);
    await ticks(d.fetchFn, 1e12 + 92 * 60_000);
    expect(status()['checkedAt']).toBe(1e12 + 92 * 60_000);
  });

  it('keeps no installer of another version', async () => {
    writeFileSync(join(cfg['agentDir'] ?? '', 'CoffeeLounge-Setup-1.2.9.exe'), 'old');
    await ticks(downloads().fetchFn, 1e12);
    expect(readdirSync(cfg['agentDir'] ?? '').filter((n) => n.endsWith('.exe'))).toEqual([
      'CoffeeLounge-Setup-1.3.0.exe',
    ]);
  });
});
