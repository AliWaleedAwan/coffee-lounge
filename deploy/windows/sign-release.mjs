// Writes latest.json for a release: the installer's version, address and SHA-256, signed with
// the release key (the UPDATE_SIGNING_KEY secret; never in the repository).
//   node sign-release.mjs <installer.exe> <version> <url> <out.json>
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { signedText } from './update-agent.mjs';

const [installer, version, url, out] = process.argv.slice(2);
const pem = process.env.UPDATE_SIGNING_KEY;
if (!installer || !version || !url || !out || !pem) throw new Error('missing argument or key');
const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
const manifest = { version, url, sha256 };
const signature = sign(null, Buffer.from(signedText(manifest)), createPrivateKey(pem)).toString(
  'base64',
);
writeFileSync(out, JSON.stringify({ ...manifest, signature }, null, 2));
