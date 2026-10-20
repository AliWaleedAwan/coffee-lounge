// GET a URL and print {status, headers, error} as JSON (Windows tests).
//   node http-get.mjs <url> [<root-ca.pem>|-]
// With a CA file, only that root is trusted; with "-", Node's default trust store.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const [url, caFile = '-'] = process.argv.slice(2);
const ca = caFile === '-' ? undefined : readFileSync(caFile, 'utf8');
const client = url.startsWith('https:') ? https : http;
const req = client.get(url, ca ? { ca } : {}, (res) => {
  res.resume();
  res.on('end', () => {
    console.log(JSON.stringify({ status: res.statusCode, headers: res.headers }));
  });
});
req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
req.on('error', (e) => {
  console.log(JSON.stringify({ status: 0, error: e.code ?? e.message }));
});
