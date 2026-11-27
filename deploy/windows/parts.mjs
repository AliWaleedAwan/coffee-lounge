// Small updates (owner's request, Nov 2026). A release is cut into parts, one per folder of the
// bundle, each with a fingerprint of its content: an unchanged part has the same fingerprint in
// every release, so the updater downloads only the parts that changed and takes the rest from
// what is installed. "meta" (VERSION.txt and parts.json) changes every release.
//
//   node parts.mjs hash <bundle>             writes <bundle>/parts.json
//   node parts.mjs pack <bundle> <outDir>    one .tar.gz per part, and <outDir>/parts.json
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PART_NAMES = ['app', 'web', 'desktop', 'runtime', 'pgsql', 'winsw', 'setup'];
export const META_FILES = ['VERSION.txt', 'parts.json'];

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Content only: paths (with / as separator) and the bytes of every file, never their dates. */
export function hashPart(dir) {
  const lines = filesUnder(dir)
    .map((file) => {
      const path = relative(dir, file).split(sep).join('/');
      return `${path}\u0000${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
    })
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function hashBundle(bundle) {
  const parts = {};
  for (const name of PART_NAMES) {
    if (!existsSync(join(bundle, name))) throw new Error(`the bundle has no ${name} folder`);
    parts[name] = hashPart(join(bundle, name));
  }
  const version = readFileSync(join(bundle, 'VERSION.txt'));
  parts.meta = createHash('sha256').update(version).digest('hex');
  return parts;
}

/** The exact text the release key signs for the parts (the installer has its own signature). */
export function partsText(version, parts) {
  const lines = [...parts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name} ${p.hash} ${p.sha256} ${String(p.size)} ${p.url}`);
  return `coffee-lounge-parts\n${version}\n${lines.join('\n')}\n`;
}

// Windows' own tar (bsdtar): another tar on PATH, such as Git's, reads C: as a remote host.
const TAR =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

function tar(args) {
  const run = spawnSync(TAR, args, { encoding: 'utf8' });
  if (run.status !== 0) {
    const said = [run.stderr, run.stdout, run.error?.message].filter(Boolean).join(' ').trim();
    throw new Error(
      `${TAR} ${args.join(' ')} failed (exit ${String(run.status)}, ${String(run.signal)}): ${said}`,
    );
  }
}

/** One .tar.gz per part, named by its fingerprint; returns what the manifest lists. */
export function packBundle(bundleDir, outPath) {
  const bundle = resolve(bundleDir);
  const outDir = resolve(outPath);
  mkdirSync(outDir, { recursive: true });
  const parts = JSON.parse(readFileSync(join(bundle, 'parts.json'), 'utf8')).parts;
  const list = [];
  for (const [name, hash] of Object.entries(parts)) {
    const file = `${name}-${hash.slice(0, 16)}.tar.gz`;
    const target = join(outDir, file);
    if (name === 'meta') tar(['-czf', target, '-C', bundle, ...META_FILES]);
    else tar(['-czf', target, '-C', join(bundle, name), '.']);
    const bytes = readFileSync(target);
    list.push({
      name,
      hash,
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: statSync(target).size,
    });
  }
  writeFileSync(join(outDir, 'parts.json'), JSON.stringify(list, null, 2));
  return list;
}

/** Unpacks a part archive into a folder (the updater). */
export function unpack(archivePath, destPath) {
  const archive = resolve(archivePath);
  const dest = resolve(destPath);
  mkdirSync(dest, { recursive: true });
  tar(['-xzf', archive, '-C', dest]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, bundle, outDir] = process.argv.slice(2);
  if (command === 'hash' && bundle) {
    writeFileSync(
      join(bundle, 'parts.json'),
      JSON.stringify({ parts: hashBundle(bundle) }, null, 2),
    );
    console.log(`parts.json written for ${bundle}`);
  } else if (command === 'pack' && bundle && outDir) {
    const list = packBundle(bundle, outDir);
    for (const p of list) console.log(`${p.file} ${(p.size / 1048576).toFixed(1)} MB`);
  } else {
    console.error('usage: node parts.mjs hash <bundle> | pack <bundle> <outDir>');
    process.exit(2);
  }
}
