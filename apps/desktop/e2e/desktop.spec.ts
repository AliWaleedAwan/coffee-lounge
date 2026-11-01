/**
 * Counter app (Electron) on this Mac: unavailable screen and recovery, certificate
 * pinning, origin lock, CSP, no Node in pages, and AT-46 (closing the counter app does not
 * affect the server), and the download path for the app's own exports (P6-7). Windows
 * behaviour (installer, full screen, auto-start) is step 2.9.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { makePki, type Pki } from '../test/pki.ts';

// No trailing backslash: in a folder with a space, Windows would read it as an escaped quote.
const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const SERVER_DIR = fileURLToPath(new URL('../../server', import.meta.url));
const PORT = 18543;
const ORIGIN = `https://127.0.0.1:${String(PORT)}`;

let work: string;
let pki: Pki;
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'cl-desktop-e2e-'));
  pki = makePki(join(work, 'pki'));
});
test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Server {
  process: ChildProcess;
  /** The test users and registration codes the e2e server wrote. */
  stateFile: string;
  stop(): Promise<void>;
}

/** Starts a disposable shop on PORT with the given certificate. */
async function startServer(cert: string, key: string): Promise<Server> {
  const stateFile = join(work, `state-${String(Date.now())}.json`);
  const child = spawn(process.execPath, ['--env-file=../../.env', 'scripts/e2e-server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      E2E_STAFF_PORT: String(PORT),
      E2E_CUSTOMER_PORT: String(PORT + 37),
      E2E_TLS_CERT: cert,
      E2E_TLS_KEY: key,
      E2E_STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`e2e server did not start:\n${output}`));
    }, 60_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes('e2e shop ready')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`e2e server exited (${String(code)}):\n${output}`));
    });
  });
  return {
    process: child,
    stateFile,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

async function launch(
  configFile: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
  const profile = mkdtempSync(join(work, 'profile-'));
  const app = await electron.launch({
    args: [DESKTOP_DIR],
    env: {
      ...process.env,
      CL_DESKTOP_CONFIG: configFile,
      CL_USER_DATA_DIR: profile,
      ...env,
    },
  });
  return { app, page: await app.firstWindow(), profile };
}

function config(name: string, body: Record<string, unknown>): string {
  const file = join(work, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

const shopConfig = () =>
  config('shop', { serverUrl: ORIGIN, caCertFile: pki.rootFile, fullscreen: false });

/** GET with the test root trusted (as another shop device would after installing it). */
function readyStatus(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${ORIGIN}/health/ready`, { ca: pki.rootPem }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('server down: branded screen, then the app opens by itself when the server is up', async () => {
  const { app, page } = await launch(shopConfig());
  let server: Server | undefined;
  try {
    await expect(page.getByRole('heading', { name: 'Server unavailable' })).toBeVisible();
    expect(page.url()).toMatch(/^file:.*unavailable\.html\?reason=unreachable/);
    await expect(page.getByRole('button', { name: 'Try again now' })).toBeVisible();

    server = await startServer(pki.leafFile, pki.leafKeyFile);
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible();
    expect(page.url()).toBe(`${ORIGIN}/register`);

    // The server going away while the app is open, then a reload: back to the screen.
    await server.stop();
    server = undefined;
    await page.reload().catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'Server unavailable' })).toBeVisible();

    // "Try again now" works as soon as the server is back.
    server = await startServer(pki.leafFile, pki.leafKeyFile);
    await page.getByRole('button', { name: 'Try again now' }).click();
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await app.close();
    await server?.stop();
  }
});

/** Pretend Windows services for the start-up screen (step 8.5). */
function services(name: string, states: Record<string, string>): string {
  const file = join(work, `${name}-services.json`);
  writeFileSync(
    file,
    JSON.stringify({
      'postgresql-x64-17': 'running',
      'coffeelounge-api': 'running',
      'coffeelounge-worker': 'running',
      Spooler: 'running',
      ...states,
    }),
  );
  return file;
}

test('8.5: a stopped service is started, shown by name, and the app opens by itself', async () => {
  const file = services('stopped', {
    'postgresql-x64-17': 'stopped',
    'coffeelounge-api': 'stopped',
  });
  const { app, page, profile } = await launch(shopConfig(), { CL_SC_STATE_FILE: file });
  let server: Server | undefined;
  try {
    await expect(page.getByRole('heading', { name: 'Starting Coffee Lounge' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Status' });
    for (const label of ['Database', 'Server', 'Background jobs', 'Printer']) {
      await expect(list.getByText(label, { exact: true })).toBeVisible();
    }
    await expect
      .poll(() => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>, {
        timeout: 15_000,
      })
      .toMatchObject({ 'postgresql-x64-17': 'running', 'coffeelounge-api': 'running' });
    const log = readFileSync(join(profile, 'desktop.log'), 'utf8');
    expect(log).toContain('service start requested');

    server = await startServer(pki.leafFile, pki.leafKeyFile);
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible({
      timeout: 15_000,
    });
    // Server pages never get the local screen's bridge.
    expect(
      await page.evaluate(() =>
        Object.keys((globalThis as { coffeeLounge?: object }).coffeeLounge ?? {}),
      ),
    ).not.toContain('onServices');
  } finally {
    await app.close();
    await server?.stop();
  }
});

test('8.5: a service this account may not start says what to do, in plain words', async () => {
  const file = services('denied', { 'coffeelounge-api': 'denied' });
  const { app, page } = await launch(shopConfig(), { CL_SC_STATE_FILE: file });
  try {
    await expect(page.getByText(/may not start server\. Call the technician/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again now' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('8.5: everything running goes straight to the app', async () => {
  const server = await startServer(pki.leafFile, pki.leafKeyFile);
  const file = services('fine', {});
  const { app, page, profile } = await launch(shopConfig(), { CL_SC_STATE_FILE: file });
  try {
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible();
    expect(readFileSync(join(profile, 'desktop.log'), 'utf8')).not.toContain('local:starting');
  } finally {
    await app.close();
    await server.stop();
  }
});

test('pages get no Node, no new windows, no other origins, and inline scripts are blocked', async () => {
  const server = await startServer(pki.leafFile, pki.leafKeyFile);
  const { app, page } = await launch(shopConfig());
  try {
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible();

    const exposed = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((globalThis as { coffeeLounge?: object }).coffeeLounge ?? {}).sort(),
    }));
    expect(exposed).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['retryNow', 'version'],
    });

    // New windows are refused.
    expect(await page.evaluate(() => window.open(location.href) === null)).toBe(true);
    expect(app.windows()).toHaveLength(1);

    // The CSP blocks injected inline script.
    const inline = await page.evaluate(async () => {
      const s = document.createElement('script');
      s.textContent = 'window.__injected = true';
      document.head.append(s);
      await new Promise((r) => setTimeout(r, 100));
      return (window as { __injected?: boolean }).__injected ?? false;
    });
    expect(inline).toBe(false);

    // Requests to anything but the server never leave the PC (192.0.2.1 is a test address).
    const external = await page.evaluate(() =>
      fetch('http://192.0.2.1/', { mode: 'no-cors' }).then(
        () => 'sent',
        () => 'blocked',
      ),
    );
    expect(external).toBe('blocked');

    // Navigation to another origin (here the customer port) is cancelled.
    await page.evaluate(() => {
      location.href = 'http://127.0.0.1:18580/';
    });
    await page.waitForTimeout(1_000);
    expect(page.url()).toBe(`${ORIGIN}/register`);

    // Browser permissions are denied without asking.
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied');
  } finally {
    await app.close();
    await server.stop();
  }
});

test('a server with a certificate from another root is never trusted', async () => {
  const server = await startServer(pki.impostorLeafFile, pki.impostorKeyFile);
  const { app, page } = await launch(shopConfig());
  try {
    await expect(page.getByRole('heading', { name: 'Server not trusted' })).toBeVisible();
    await expect(page.getByText(/Do not enter any password/)).toBeVisible();
    await page.waitForTimeout(7_000); // at least two automatic retries
    expect(page.url()).toMatch(/^file:.*reason=certificate/);
  } finally {
    await app.close();
    await server.stop();
  }
});

test('a shop certificate signed with SHA-1 is not trusted either', async () => {
  const server = await startServer(pki.weakFile, pki.weakKeyFile);
  const { app, page } = await launch(shopConfig());
  try {
    await expect(page.getByRole('heading', { name: 'Server not trusted' })).toBeVisible();
    expect(page.url()).toMatch(/^file:.*reason=certificate/);
  } finally {
    await app.close();
    await server.stop();
  }
});

test('an app without valid settings says so and does not retry', async () => {
  const { app, page } = await launch(join(work, 'does-not-exist.json'));
  try {
    await expect(page.getByRole('heading', { name: 'Counter app not set up' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again now' })).toBeHidden();
  } finally {
    await app.close();
  }
});

test('AT-46: closing the counter app leaves the server running for every other device', async () => {
  const server = await startServer(pki.leafFile, pki.leafKeyFile);
  try {
    const { app, page } = await launch(shopConfig());
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible();
    await app.close();
    expect(server.process.exitCode).toBeNull();
    expect(await readyStatus()).toBe(200);
  } finally {
    await server.stop();
  }
});

test('P6-7: an export saves into the download folder; any other download is refused', async () => {
  const server = await startServer(pki.leafFile, pki.leafKeyFile);
  const downloads = mkdtempSync(join(work, 'downloads-'));
  const { app, page, profile } = await launch(shopConfig(), { CL_DOWNLOAD_DIR: downloads });
  try {
    const state = JSON.parse(readFileSync(server.stateFile, 'utf8')) as {
      owner: { username: string; password: string };
      codes: string[];
    };
    await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible();
    await page.getByLabel('Registration code').fill(state.codes[0] ?? '');
    await page.getByRole('button', { name: 'Register device' }).click();
    await page.getByLabel('Username').fill(state.owner.username);
    await page.getByLabel('Password').fill(state.owner.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    await page.goto(`${ORIGIN}/reports?report=payment-mix`);
    await page.getByRole('link', { name: 'Download CSV' }).click();
    await expect.poll(() => readdirSync(downloads), { timeout: 10_000 }).toHaveLength(1);
    const [file = ''] = readdirSync(downloads);
    expect(file).toMatch(/^payment-mix_\d{4}-\d{2}-\d{2}(_\d{4}-\d{2}-\d{2})?\.csv$/);
    expect(readFileSync(join(downloads, file), 'utf8').startsWith('\uFEFFMethod,')).toBe(true);

    // The same server, but not an export: refused, nothing saved.
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = '/api/staff/v1/reports/payment-mix';
      a.download = 'report.json';
      document.body.append(a);
      a.click();
    });
    await expect
      .poll(() => readFileSync(join(profile, 'desktop.log'), 'utf8'), { timeout: 10_000 })
      .toContain('download blocked');
    expect(readdirSync(downloads)).toEqual([file]);
    expect(readFileSync(join(profile, 'desktop.log'), 'utf8')).toContain('download saved');
  } finally {
    await app.close();
    await server.stop();
  }
});
