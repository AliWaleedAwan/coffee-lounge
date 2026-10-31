/**
 * Unpacks the tar that pg_basebackup writes (ustar and the GNU long-name entries it uses),
 * for a restore (step 7.3). Only folders and regular files; a path that would leave the
 * target folder is refused.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

const text = (b: Buffer, start: number, length: number) =>
  b
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '');

export function extractTar(tar: Buffer, target: string): number {
  let offset = 0;
  let files = 0;
  let longName: string | null = null;
  mkdirSync(target, { recursive: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const prefix = text(header, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    longName = null;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    name = name.replace(/^\.\//, '');
    if (name === '' || name === '.') continue;
    const path = normalize(join(target, name));
    if (!path.startsWith(normalize(target) + sep) && path !== normalize(target))
      throw new Error(`the backup holds a path outside its folder: ${name}`);
    if (type === '5') mkdirSync(path, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, body);
      files += 1;
    }
    // Links and other types do not occur in a base backup without tablespaces.
  }
  return files;
}
