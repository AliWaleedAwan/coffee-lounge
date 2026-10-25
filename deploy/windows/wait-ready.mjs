// Waits until a Coffee Lounge listener answers /health/ready with 200.
// Used by install.ps1 and the Windows tests with the bundled node.exe:
//   node wait-ready.mjs <url> [<root-ca.pem>|-] [timeoutSeconds]
// Trusts only the given shop root for https (never the Windows store).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const [url, caFile = '-', timeout = '180'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node wait-ready.mjs <url> [ca.pem|-] [timeoutSeconds]');
  process.exit(2);
}
const ca = caFile === '-' ? undefined : readFileSync(caFile, 'utf8');
const deadline = Date.now() + Number(timeout) * 1000;

function once() {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, ca ? { ca } : {}, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

let last = { status: 0, body: '' };
while (Date.now() < deadline) {
  last = await once();
  if (last.status === 200) {
    console.log(`ready: ${url} ${last.body}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`not ready after ${timeout} s: ${url} → ${String(last.status)} ${last.body}`);
process.exit(1);
