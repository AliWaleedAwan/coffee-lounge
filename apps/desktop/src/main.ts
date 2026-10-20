/**
 * Counter PC shell (02-architecture §2.11). Loads the staff web app from the shop server
 * and holds no business logic. Hardened: sandboxed, context-isolated renderers without
 * Node, navigation and network locked to the server origin, the server certificate
 * pinned to the shop root, no permissions, no downloads, no new windows. If the server
 * cannot be reached it shows its own "Server unavailable" screen and keeps retrying.
 *
 * Environment: CL_DESKTOP_CONFIG (config file; default on Windows
 * %ProgramData%\CoffeeLounge\desktop\desktop.json, elsewhere <userData>/desktop.json),
 * CL_USER_DATA_DIR (separate profile, used by tests).
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, net, session, type Session } from 'electron';
import { ConfigError, loadDesktopConfig, type DesktopConfig } from './config.ts';
import { chainOf, chromiumAcceptable, pinnedVerdict } from './pinning.ts';
import {
  classifyLoadFailure,
  isAllowedRequest,
  isServerPage,
  withCsp,
  type FailureKind,
} from './policy.ts';

const STATIC_DIR = fileURLToPath(new URL('../static/', import.meta.url));
const STATIC_URL = pathToFileURL(STATIC_DIR).href;
const PROBE_MS = 3_000;
/** A certificate refusal this recent explains a failed load. */
const CERT_FAILURE_WINDOW_MS = 10_000;

type Reason = FailureKind | 'config';

if (process.env['CL_USER_DATA_DIR']) app.setPath('userData', process.env['CL_USER_DATA_DIR']);
if (!app.requestSingleInstanceLock()) app.quit();
app.enableSandbox();

let window: BrowserWindow | null = null;
let config: DesktopConfig | null = null;
let showing: 'app' | Reason | null = null;
let probeTimer: NodeJS.Timeout | undefined;
let lastCertFailure: { at: number; reason: string } | null = null;

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ time: new Date().toISOString(), name: 'desktop', msg, ...extra }));
};

function recentCertFailure(): boolean {
  return lastCertFailure !== null && Date.now() - lastCertFailure.at < CERT_FAILURE_WINDOW_MS;
}

/** Session-wide rules; applied before any window exists. */
function hardenSession(ses: Session, cfg: DesktopConfig | null): void {
  const origin = cfg?.serverOrigin ?? 'null';
  ses.setCertificateVerifyProc((request, callback) => {
    if (!cfg?.root) {
      callback(-2); // no https anywhere without a pinned root
      return;
    }
    const pinned = pinnedVerdict(
      { hostname: request.hostname, chain: chainOf(request.certificate) },
      { host: cfg.serverHost, root: cfg.root },
    );
    const verdict =
      pinned.ok && !chromiumAcceptable(request.errorCode)
        ? { ok: false as const, reason: `rejected by Chromium: ${request.verificationResult}` }
        : pinned;
    if (verdict.ok) {
      callback(0);
      return;
    }
    if (request.hostname === cfg.serverHost) {
      lastCertFailure = { at: Date.now(), reason: verdict.reason };
      log('server certificate refused', { reason: verdict.reason });
    }
    callback(-2);
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequest(details.url, origin, STATIC_URL);
    if (!allowed) log('request blocked', { url: details.url.slice(0, 200) });
    callback({ cancel: !allowed });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const isDocument = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    if (isDocument && isServerPage(details.url, origin)) {
      callback({ responseHeaders: withCsp(details.responseHeaders ?? {}).headers });
      return;
    }
    callback({});
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => {
    event.preventDefault(); // exports arrive in a later phase, through a reviewed path
  });
}

/** Rules for every web contents, including any the page might try to create. */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const lock = (event: { preventDefault(): void }, url: string): void => {
    if (!config || !isServerPage(url, config.serverOrigin)) {
      log('navigation blocked', { url: url.slice(0, 200) });
      event.preventDefault();
    }
  };
  contents.on('will-navigate', (event) => {
    lock(event, event.url);
  });
  contents.on('will-redirect', (event) => {
    lock(event, event.url);
  });
  contents.on('will-frame-navigate', (event) => {
    lock(event, event.url);
  });
});

function stopProbe(): void {
  clearInterval(probeTimer);
  probeTimer = undefined;
}

async function showApp(): Promise<void> {
  if (!window || !config) return;
  showing = 'app';
  stopProbe();
  try {
    await window.loadURL(`${config.serverOrigin}/`);
  } catch {
    // did-fail-load shows the unavailable screen
  }
}

function showUnavailable(reason: Reason, detail?: string): void {
  if (!window) return;
  if (showing !== reason) {
    showing = reason;
    void window.loadFile(join(STATIC_DIR, 'unavailable.html'), {
      query: { reason, ...(detail ? { detail } : {}) },
    });
  }
  if (reason !== 'config' && !probeTimer) {
    probeTimer = setInterval(() => void probe(), PROBE_MS);
  }
}

/** Asks the server whether it is up; opens the app as soon as it answers. */
async function probe(): Promise<void> {
  if (!config || showing === 'app') return;
  try {
    const res = await net.fetch(`${config.serverOrigin}/health/live`, { cache: 'no-store' });
    if (res.ok) {
      log('server reachable; opening the app');
      await showApp();
    }
  } catch {
    showUnavailable(recentCertFailure() ? 'certificate' : 'unreachable');
  }
}

function createWindow(cfg: DesktopConfig | null): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Coffee Lounge',
    width: 1366,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#FAF7F2',
    fullscreen: cfg?.fullscreen ?? false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(STATIC_DIR, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      additionalArguments: [`--cl-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || !cfg || !isServerPage(url, cfg.serverOrigin)) return;
    const kind = recentCertFailure() ? 'certificate' : classifyLoadFailure(code);
    if (!kind) return;
    log('app failed to load', { code, description, kind });
    showUnavailable(kind);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log('page crashed; reloading', { reason: details.reason });
    if (showing === 'app') void showApp();
  });
  win.on('closed', () => {
    window = null;
    stopProbe();
  });
  return win;
}

/**
 * Windows: written by the installer where the Counter user can read but not change it
 * (WINDOWS_DEPLOYMENT.md §10). Elsewhere (development): the per-user profile.
 */
function defaultConfigFile(): string {
  if (process.platform === 'win32') {
    const programData = process.env['ProgramData'] ?? 'C:\\ProgramData';
    return join(programData, 'CoffeeLounge', 'desktop', 'desktop.json');
  }
  return join(app.getPath('userData'), 'desktop.json');
}

ipcMain.on('cl:retry', (event) => {
  // Only the app's own unavailable screen may ask.
  if (!event.senderFrame?.url.startsWith(STATIC_URL)) return;
  void probe();
});

app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

app.on('window-all-closed', () => {
  app.quit();
});

void app.whenReady().then(async () => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const file = process.env['CL_DESKTOP_CONFIG'] ?? defaultConfigFile();
  let configProblem: string | null = null;
  try {
    config = await loadDesktopConfig(file);
  } catch (error) {
    configProblem = error instanceof ConfigError ? error.message : String(error);
    log('configuration problem', { file, problem: configProblem });
  }
  hardenSession(session.defaultSession, config);
  window = createWindow(config);
  if (configProblem !== null) showUnavailable('config', configProblem);
  else await showApp();
});
