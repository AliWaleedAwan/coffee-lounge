/** Small updates (1.0.10): only changed parts download; anything unusual uses the full installer. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashBundle,
  hashPart,
  packBundle,
  PART_NAMES,
  partsText,
  unpack,
} from '../../../../deploy/windows/parts.mjs';
import { signedText, tick } from '../../../../deploy/windows/update-agent.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const INSTALLER = Buffer.from('the full installer');
const BASE = 'https://example.test/dl/';

let dir: string;
let cfg: Record<string, string>;
let installs: string[][];
let fetched: string[];
let release: string;

function bundle(at: string, version: string, appText: string) {
  for (const name of PART_NAMES) {
    mkdirSync(join(at, name, 'sub'), { recursive: true });
    writeFileSync(join(at, name, 'sub', 'file.txt'), `${name} contents`);
  }
  writeFileSync(join(at, 'app', 'main.js'), appText);
  writeFileSync(join(at, 'VERSION.txt'), `Coffee Lounge ${version} (abc)\n`);
  writeFileSync(join(at, 'parts.json'), JSON.stringify({ parts: hashBundle(at) }));
}

function manifest(version: string, key = privateKey) {
  const list = (
    JSON.parse(readFileSync(join(release, 'out', 'parts.json'), 'utf8')) as {
      name: string;
      hash: string;
      sha256: string;
      size: number;
      file: string;
    }[]
  ).map(({ file, ...p }) => ({ ...p, url: BASE + file }));
  const m = {
    version,
    url: `${BASE}setup.exe`,
    sha256: createHash('sha256').update(INSTALLER).digest('hex'),
  };
  return JSON.stringify({
    ...m,
    signature: sign(null, Buffer.from(signedText(m)), privateKey).toString('base64'),
    parts: list,
    partsSignature: sign(null, Buffer.from(partsText(version, list)), key).toString('base64'),
  });
}

function go(text: string) {
  const fetchFn = (url: string) => {
    fetched.push(url);
    if (url === cfg['manifestUrl']) return Promise.resolve(new Response(text));
    if (url === `${BASE}setup.exe`) return Promise.resolve(new Response(new Uint8Array(INSTALLER)));
    const file = join(release, 'out', url.slice(BASE.length));
    return Promise.resolve(new Response(new Uint8Array(readFileSync(file))));
  };
  return tick(cfg, {
    fetchFn,
    now: 1e12,
    install: (file: string, args: string[]) => {
      installs.push([file, ...args]);
      return Promise.resolve(0);
    },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cl-parts-'));
  installs = [];
  fetched = [];
  for (const d of ['update', 'agent', 'logs']) mkdirSync(join(dir, d));
  bundle(join(dir, 'install'), '1.2.3', 'old app');
  release = join(dir, 'release');
  bundle(join(release, 'bundle'), '1.3.0', 'new app');
  await packBundle(join(release, 'bundle'), join(release, 'out'));
  const publicKeyFile = join(dir, 'agent', 'public.pem');
  writeFileSync(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  cfg = {
    manifestUrl: 'https://example.test/latest.json',
    publicKeyFile,
    installDir: join(dir, 'install'),
    updateDir: join(dir, 'update'),
    agentDir: join(dir, 'agent'),
    logDir: join(dir, 'logs'),
    databaseFile: join(dir, 'database.json'),
  };
  writeFileSync(join(dir, 'update', 'request'), '');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parts', () => {
  it('fingerprints content only, and a packed part unpacks to the same fingerprint', async () => {
    const a = join(release, 'bundle', 'web');
    const copy = join(dir, 'web-copy');
    cpSync(a, copy, { recursive: true });
    expect(hashPart(copy)).toBe(hashPart(a));
    writeFileSync(join(copy, 'sub', 'file.txt'), 'changed');
    expect(hashPart(copy)).not.toBe(hashPart(a));
    const back = join(dir, 'unpacked');
    const webFile = (
      JSON.parse(readFileSync(join(release, 'out', 'parts.json'), 'utf8')) as {
        name: string;
        file: string;
      }[]
    ).find((p) => p.name === 'web')?.file;
    await unpack(join(release, 'out', webFile ?? ''), back);
    expect(hashPart(back)).toBe(hashPart(a));
  });
});

describe('the updater with parts', () => {
  it('downloads only the changed parts and installs the assembled bundle with the setup script', async () => {
    await go(manifest('1.3.0'));
    const downloads = fetched.filter((u) => u.startsWith(BASE)).map((u) => u.slice(BASE.length));
    expect(downloads.map((f) => f.split('-')[0]).sort()).toEqual(['app', 'meta']);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.[0]).toMatch(/powershell\.exe$/i);
    const stage = join(dir, 'agent', 'stage');
    expect(installs[0]).toContain(join(stage, 'setup', 'install.ps1'));
    // Cleaned up after the install.
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(join(dir, 'agent', 'parts'))).toBe(false);
  });

  it('uses the full installer when the parts signature is not the release key', async () => {
    await go(manifest('1.3.0', generateKeyPairSync('ed25519').privateKey));
    expect(fetched).toContain(`${BASE}setup.exe`);
    expect(installs[0]?.[0]).toMatch(/CoffeeLounge-Setup-1\.3\.0\.exe$/);
  });

  it('uses the full installer when the installed program has no record of its parts', async () => {
    rmSync(join(dir, 'install', 'parts.json'));
    await go(manifest('1.3.0'));
    expect(installs[0]?.[0]).toMatch(/CoffeeLounge-Setup-1\.3\.0\.exe$/);
  });

  it('uses the full installer when an installed part was changed on this PC', async () => {
    writeFileSync(join(dir, 'install', 'web', 'sub', 'file.txt'), 'tampered');
    await go(manifest('1.3.0'));
    expect(installs[0]?.[0]).toMatch(/CoffeeLounge-Setup-1\.3\.0\.exe$/);
  });
});
