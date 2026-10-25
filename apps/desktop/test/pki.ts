/**
 * Throwaway certificates for tests, made with the system `openssl`: the shop root, an
 * intermediate, server certificates for 127.0.0.1, and an unrelated "impostor" root.
 * Never used outside tests (the real shop CA tool arrives in step 2.9).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXTENSIONS = `
[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[leaf_ip]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1
[leaf_other]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:192.168.100.250
`;

export interface Pki {
  dir: string;
  rootPem: string;
  rootFile: string;
  intermediatePem: string;
  /** Server certificate for 127.0.0.1 signed by the shop root, and its key file. */
  leafPem: string;
  leafFile: string;
  leafKeyFile: string;
  /** Signed by the intermediate (chain: leaf, intermediate). */
  viaIntermediatePem: string;
  /** Signed by the shop root, but for another address. */
  otherHostPem: string;
  /** Signed by the shop root with SHA-1, and its key file. */
  weakPem: string;
  weakFile: string;
  weakKeyFile: string;
  /** A different root and a 127.0.0.1 certificate it signed. */
  impostorRootPem: string;
  impostorLeafFile: string;
  impostorKeyFile: string;
  impostorLeafPem: string;
}

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function newKey(dir: string, name: string): void {
  openssl(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
}

function selfSignedCa(dir: string, name: string, cn: string): void {
  newKey(dir, name);
  openssl(dir, [
    'req',
    '-x509',
    '-new',
    '-key',
    `${name}.key`,
    '-out',
    `${name}.pem`,
    '-days',
    '30',
    '-subj',
    `/CN=${cn}`,
    '-config',
    'ext.cnf',
    '-extensions',
    'ca',
    '-sha256',
  ]);
}

// LibreSSL signs with SHA-1 unless told otherwise; only the "weak" certificate wants that.
function signed(
  dir: string,
  name: string,
  cn: string,
  issuer: string,
  ext: string,
  digest: 'sha256' | 'sha1' = 'sha256',
): void {
  newKey(dir, name);
  openssl(dir, [
    'req',
    '-new',
    '-key',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    `/CN=${cn}`,
    '-config',
    'ext.cnf',
  ]);
  openssl(dir, [
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    `${issuer}.pem`,
    '-CAkey',
    `${issuer}.key`,
    '-CAcreateserial',
    '-out',
    `${name}.pem`,
    '-days',
    '30',
    '-extfile',
    'ext.cnf',
    '-extensions',
    ext,
    `-${digest}`,
  ]);
}

export function makePki(dir: string): Pki {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ext.cnf'), EXTENSIONS);
  selfSignedCa(dir, 'root', 'Coffee Lounge Test Root');
  signed(dir, 'intermediate', 'Coffee Lounge Test Intermediate', 'root', 'ca');
  signed(dir, 'leaf', '127.0.0.1', 'root', 'leaf_ip');
  signed(dir, 'via-intermediate', '127.0.0.1', 'intermediate', 'leaf_ip');
  signed(dir, 'other-host', '192.168.100.250', 'root', 'leaf_other');
  signed(dir, 'weak', '127.0.0.1', 'root', 'leaf_ip', 'sha1');
  selfSignedCa(dir, 'impostor-root', 'Coffee Lounge Test Root'); // same name, different key
  signed(dir, 'impostor-leaf', '127.0.0.1', 'impostor-root', 'leaf_ip');
  const read = (name: string) => readFileSync(join(dir, `${name}.pem`), 'utf8');
  return {
    dir,
    rootPem: read('root'),
    rootFile: join(dir, 'root.pem'),
    intermediatePem: read('intermediate'),
    leafPem: read('leaf'),
    leafFile: join(dir, 'leaf.pem'),
    leafKeyFile: join(dir, 'leaf.key'),
    viaIntermediatePem: read('via-intermediate'),
    otherHostPem: read('other-host'),
    weakPem: read('weak'),
    weakFile: join(dir, 'weak.pem'),
    weakKeyFile: join(dir, 'weak.key'),
    impostorRootPem: read('impostor-root'),
    impostorLeafFile: join(dir, 'impostor-leaf.pem'),
    impostorKeyFile: join(dir, 'impostor-leaf.key'),
    impostorLeafPem: read('impostor-leaf'),
  };
}
