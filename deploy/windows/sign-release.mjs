// Writes latest.json for a release: the installer's version, address and SHA-256, signed with
// the release key (the UPDATE_SIGNING_KEY secret; never in the repository). With a parts folder
// (small updates, 1.0.10), it also lists every part with its own signature; the installer's
// signature is unchanged, so 1.0.9 updaters keep working.
//   node sign-release.mjs <installer.exe> <version> <url> <out.json> [<partsDir>]
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { partsText } from './parts.mjs';
import { signedText } from './update-agent.mjs';

const [installer, version, url, out, partsDir] = process.argv.slice(2);
const pem = process.env.UPDATE_SIGNING_KEY;
if (!installer || !version || !url || !out || !pem) throw new Error('missing argument or key');
const key = createPrivateKey(pem);
const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
const manifest = { version, url, sha256 };
const signature = sign(null, Buffer.from(signedText(manifest)), key).toString('base64');
const result = { ...manifest, signature };
if (partsDir) {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const parts = JSON.parse(readFileSync(join(partsDir, 'parts.json'), 'utf8')).map((p) => ({
    name: p.name,
    hash: p.hash,
    sha256: p.sha256,
    size: p.size,
    url: base + p.file,
  }));
  result.parts = parts;
  result.partsSignature = sign(null, Buffer.from(partsText(version, parts)), key).toString(
    'base64',
  );
}
writeFileSync(out, JSON.stringify(result, null, 2));
