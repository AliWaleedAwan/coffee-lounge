/**
 * Electron fuses for the counter app (SECURITY.md §2.7, WINDOWS_DEPLOYMENT.md §10): switches
 * baked into the executable that turn off ways to run other code with it.
 *   node scripts/fuses.mjs check <path to the packaged executable>
 */
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';

export const FUSES = {
  // `ELECTRON_RUN_AS_NODE=1 CoffeeLounge.exe` must not become a Node.js shell.
  [FuseV1Options.RunAsNode]: false,
  // NODE_OPTIONS and --inspect could inject code or a debugger.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Load the app only from its asar archive, and refuse a modified archive.
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // Cookies (device and session) encrypted at rest with the OS key store.
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // file:// pages (the unavailable screen) get no extra powers.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

export async function applyFuses(executable) {
  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    ...FUSES,
  });
}

/** Returns the fuses whose state differs from FUSES (empty when all are right). */
export async function wrongFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  const wrong = [];
  for (const [option, wanted] of Object.entries(FUSES)) {
    const state = wire[option];
    // FuseState: '0' disabled, '1' enabled (as character codes in the wire).
    const enabled = state === 49 || state === '1' || state === 1;
    if (enabled !== wanted) wrong.push(`${FuseV1Options[option]} is ${enabled ? 'on' : 'off'}`);
  }
  return wrong;
}

if (process.argv[2] === 'check') {
  const exe = process.argv[3];
  if (!exe) {
    console.error('usage: node scripts/fuses.mjs check <executable>');
    process.exit(2);
  }
  const wrong = await wrongFuses(exe);
  if (wrong.length > 0) {
    console.error(`Fuses not as required: ${wrong.join('; ')}`);
    process.exit(1);
  }
  console.log(`All ${String(Object.keys(FUSES).length)} fuses as required in ${exe}`);
}
