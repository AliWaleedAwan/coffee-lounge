// Small updates (owner's request, Nov 2026). A release is cut into parts, one per folder of the
// bundle, each with a fingerprint of its content: an unchanged part has the same fingerprint in
// every release, so the updater downloads only the parts that changed and takes the rest from
// what is installed. "meta" (VERSION.txt and parts.json) changes every release.
//
//   node parts.mjs hash <bundle>             writes <bundle>/parts.json
//   node parts.mjs pack <bundle> <outDir>    one .part.gz per part, and <outDir>/parts.json
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

// The archive format is our own, written and read by this file only (Windows' tar.exe crashes
// on GitHub's runners): gzip over records of [4-byte header length][JSON {path, size}][bytes].

function writeAll(out, chunk) {
  return out.write(chunk) ? Promise.resolve() : new Promise((ok) => out.once('drain', ok));
}

/** Packs files (relative path -> absolute file) into one .part.gz. */
async function packFiles(entries, target) {
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(target);
  const done = pipeline(gz, out);
  for (const [path, file] of entries) {
    const size = statSync(file).size;
    const header = Buffer.from(JSON.stringify({ path, size }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    await writeAll(gz, Buffer.concat([len, header]));
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      let n;
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0)
        await writeAll(gz, Buffer.from(buf.subarray(0, n)));
    } finally {
      closeSync(fd);
    }
  }
  gz.end();
  await done;
}

/** One .part.gz per part, named by its fingerprint; returns what the manifest lists. */
export async function packBundle(bundleDir, outPath) {
  const bundle = resolve(bundleDir);
  const outDir = resolve(outPath);
  mkdirSync(outDir, { recursive: true });
  const parts = JSON.parse(readFileSync(join(bundle, 'parts.json'), 'utf8')).parts;
  const list = [];
  for (const [name, hash] of Object.entries(parts)) {
    const file = `${name}-${hash.slice(0, 16)}.part.gz`;
    const target = join(outDir, file);
    const entries =
      name === 'meta'
        ? META_FILES.map((m) => [m, join(bundle, m)])
        : filesUnder(join(bundle, name)).map((p) => [
            relative(join(bundle, name), p).split(sep).join('/'),
            p,
          ]);
    await packFiles(entries, target);
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

/** Unpacks a part archive into a folder (the updater); refuses any path outside it. */
export async function unpack(archivePath, destPath) {
  const dest = resolve(destPath);
  mkdirSync(dest, { recursive: true });
  let pending = Buffer.alloc(0);
  let current = null; // { fd, left }
  const takeFile = (path, size) => {
    const target = resolve(dest, path);
    if (path.split('/').includes('..') || !target.startsWith(dest + sep))
      throw new Error(`bad path in part: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    return { fd: openSync(target, 'w'), left: size };
  };
  for await (const chunk of createReadStream(resolve(archivePath)).pipe(createGunzip())) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (current) {
        const n = Math.min(current.left, pending.length);
        if (n > 0) writeSync(current.fd, pending, 0, n);
        current.left -= n;
        pending = pending.subarray(n);
        if (current.left > 0) break;
        closeSync(current.fd);
        current = null;
      }
      if (pending.length < 4) break;
      const len = pending.readUInt32BE(0);
      if (pending.length < 4 + len) break;
      const { path, size } = JSON.parse(pending.subarray(4, 4 + len).toString('utf8'));
      pending = pending.subarray(4 + len);
      current = takeFile(path, size);
    }
  }
  if (current) {
    const short = current.left;
    closeSync(current.fd);
    if (short > 0) throw new Error('the part archive is cut short');
  }
  if (pending.length) throw new Error('the part archive has trailing bytes');
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
    const list = await packBundle(bundle, outDir);
    for (const p of list) console.log(`${p.file} ${(p.size / 1048576).toFixed(1)} MB`);
  } else {
    console.error('usage: node parts.mjs hash <bundle> | pack <bundle> <outDir>');
    process.exit(2);
  }
}
