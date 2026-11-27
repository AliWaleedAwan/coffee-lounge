/**
 * Packages the counter app (step 2.9b): the built main process and static files in an asar
 * archive, then the fuses (scripts/fuses.mjs). Windows is the target; other platforms
 * are for checking the result on a developer machine.
 *   node scripts/package.mjs [win32|darwin] [outDir]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { applyFuses, wrongFuses } from './fuses.mjs';

const dir = fileURLToPath(new URL('..', import.meta.url));
const platform = process.argv[2] ?? 'win32';
const out = process.argv[3] ?? join(dir, 'out');
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

const [appPath] = await packager({
  dir,
  out,
  platform,
  arch: platform === 'darwin' ? process.arch : 'x64',
  name: 'CoffeeLounge',
  executableName: 'CoffeeLounge',
  appVersion: manifest.version,
  electronVersion: manifest.devDependencies.electron,
  asar: true,
  icon: join(dir, 'assets', 'icon.ico'),
  // The app has no runtime dependencies: nothing from node_modules belongs in it.
  prune: false,
  overwrite: true,
  // Only dist/, static/ and package.json are the app.
  ignore: [
    /^\/(node_modules|src|test|e2e|scripts|assets|out|test-results|playwright-report)(\/|$)/,
    /^\/(tsconfig.*|playwright\.config\.ts)$/,
  ],
  win32metadata: {
    CompanyName: 'Coffee Lounge',
    ProductName: 'Coffee Lounge',
    FileDescription: 'Coffee Lounge counter app',
    OriginalFilename: 'CoffeeLounge.exe',
  },
});

const executable =
  platform === 'win32'
    ? join(appPath, 'CoffeeLounge.exe')
    : platform === 'darwin'
      ? join(appPath, 'CoffeeLounge.app')
      : join(appPath, 'CoffeeLounge');
await applyFuses(executable);
const wrong = await wrongFuses(executable);
if (wrong.length > 0) throw new Error(`Fuses not as required: ${wrong.join('; ')}`);
console.log(`Packaged ${platform} app with fuses: ${appPath}`);
