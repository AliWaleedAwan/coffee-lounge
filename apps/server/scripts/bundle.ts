/**
 * Builds the installable server (WINDOWS_DEPLOYMENT.md §1): one ESM file per entry point
 * in dist/. Our TypeScript and the shared package are bundled; npm dependencies stay
 * external and come from `pnpm deploy --prod` next to it. Needed because Node does not
 * strip types inside node_modules, where the shared package would otherwise live.
 *
 *   node scripts/bundle.ts
 */
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};
const external = Object.keys(manifest.dependencies).filter((name) => !name.startsWith('@cl/'));

const ENTRIES = {
  main: 'src/main.ts',
  worker: 'src/worker.ts',
  migrate: 'src/platform/db/migrate-cli.ts',
  admin: 'src/cli/admin.ts',
  certs: 'src/cli/certs.ts',
  'wal-archive': 'src/cli/wal-archive.ts',
};

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
const result = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ENTRIES,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  splitting: true, // entries share platform code
  chunkNames: 'chunks/[name]-[hash]',
  external,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
const files = Object.keys(result.metafile.outputs);
console.log(
  `bundled ${String(Object.keys(ENTRIES).length)} entries into ${String(files.length)} files; external: ${external.join(', ')}`,
);
