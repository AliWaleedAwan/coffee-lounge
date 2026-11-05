/**
 * Counter app configuration, written by the installer (WINDOWS_DEPLOYMENT.md §1):
 *
 *   { "serverUrl": "https://127.0.0.1:8443",
 *     "caCertFile": "coffee-lounge-root.pem",   // relative to this file
 *     "fullscreen": true,
 *     "databaseService": "postgresql-x64-17" }   // the PostgreSQL service the installer chose
 *
 * HTTPS requires the shop root certificate: the app trusts that root and nothing else
 * for the server (LOCAL_LAN_HOSTING.md §5). Plain HTTP is accepted only for a loopback
 * address in development.
 */
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

export interface DesktopConfig {
  /** Origin of the staff listener, e.g. https://127.0.0.1:8443 */
  serverOrigin: string;
  /** Host name or IP the server certificate must match. */
  serverHost: string;
  /** The pinned shop root, or null for development over loopback HTTP. */
  root: X509Certificate | null;
  fullscreen: boolean;
  /** The PostgreSQL service behind the server (step 8.5); the default for older installs. */
  databaseService: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadDesktopConfig(file: string): Promise<DesktopConfig> {
  let raw: unknown;
  try {
    // Windows tools (Notepad, PowerShell 5.1) may start the file with a byte-order mark.
    raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`Cannot read ${file}: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new ConfigError('The configuration must be a JSON object');
  const readCa = async (name: string): Promise<string> =>
    readFile(isAbsolute(name) ? name : join(dirname(file), name), 'utf8');
  return parseDesktopConfig(raw, readCa);
}

export async function parseDesktopConfig(
  raw: Record<string, unknown>,
  readCa: (name: string) => Promise<string>,
): Promise<DesktopConfig> {
  const { serverUrl, caCertFile, fullscreen, databaseService } = raw;
  if (typeof serverUrl !== 'string') throw new ConfigError('serverUrl is missing');
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new ConfigError(`serverUrl "${serverUrl}" is not a URL`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError('serverUrl must be an origin only, e.g. https://127.0.0.1:8443');
  }
  if (
    databaseService !== undefined &&
    (typeof databaseService !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(databaseService))
  ) {
    throw new ConfigError('databaseService must be a Windows service name');
  }
  if (fullscreen !== undefined && typeof fullscreen !== 'boolean') {
    throw new ConfigError('fullscreen must be true or false');
  }

  let root: X509Certificate | null = null;
  if (url.protocol === 'https:') {
    if (typeof caCertFile !== 'string') {
      throw new ConfigError('caCertFile (the shop root certificate) is required for https');
    }
    try {
      root = new X509Certificate(await readCa(caCertFile));
    } catch (error) {
      throw new ConfigError(`Cannot read the shop root certificate: ${(error as Error).message}`);
    }
    if (!root.ca) throw new ConfigError('caCertFile is not a CA certificate');
  } else if (url.protocol === 'http:') {
    if (!LOOPBACK.has(url.hostname)) {
      throw new ConfigError('Plain http is allowed only for a loopback address (development)');
    }
  } else {
    throw new ConfigError('serverUrl must use https');
  }

  return {
    serverOrigin: url.origin,
    serverHost: url.hostname.replace(/^\[|\]$/g, ''),
    root,
    fullscreen: fullscreen ?? false,
    databaseService: databaseService ?? 'postgresql-x64-17',
  };
}
