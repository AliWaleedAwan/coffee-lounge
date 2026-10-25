/**
 * Shop certificates (LOCAL_LAN_HOSTING.md §5, D-39): a private root CA and the staff
 * server certificate it signs. Node can read certificates but not make them, and
 * Windows has no openssl, so this encodes the one fixed profile we need in DER and signs
 * it with Node's crypto. ECDSA P-256 with SHA-256 throughout.
 *
 * Server certificate: SANs for the shop address and 127.0.0.1 (the counter app on the
 * server itself), EKU serverAuth, at most 825 days (Apple's limit; we use 730).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';

const DAY_MS = 86_400_000;
export const SERVER_CERT_DAYS = 730;
export const MAX_SERVER_CERT_DAYS = 825;
export const ROOT_CA_YEARS = 10;

// ------------------------------------------------------------------ DER encoding

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.of(tag), length(content.length), content]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bitString = (b: Buffer, unusedBits = 0): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.of(unusedBits), b]));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.of(v ? 0xff : 0x00));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content);

function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && ((b[1] ?? 0) & 0x80) === 0) b = b.subarray(1);
  if (((b[0] ?? 0) & 0x80) !== 0) b = Buffer.concat([Buffer.of(0), b]); // keep it positive
  return tlv(0x02, b);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const [first = 0, second = 0, ...rest] = parts;
  const out: number[] = [first * 40 + second];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date: Date): Buffer {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = iso.slice(0, 19).replace(/[-:T]/g, '');
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
};

function name(commonName: string, organization: string): Buffer {
  const attr = (type: string, value: string) =>
    set(seq(oid(type), tlv(0x0c, Buffer.from(value, 'utf8')))); // UTF8String
  return seq(attr(OID.organization, organization), attr(OID.commonName, commonName));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

/** SHA-1 of the subjectPublicKey bits (RFC 5280 §4.2.1.2 method 1; an identifier only). */
function keyId(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // The SubjectPublicKeyInfo ends with the BIT STRING of the key: for P-256, 65 bytes.
  return createHash('sha1')
    .update(spki.subarray(spki.length - 65))
    .digest();
}

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  throw new Error(`Only IPv4 addresses are supported in the certificate: ${ip}`);
}

interface TbsInput {
  serial: Buffer;
  issuer: Buffer;
  subject: Buffer;
  notBefore: Date;
  notAfter: Date;
  publicKey: KeyObject;
  extensions: Buffer[];
}

function certificate(tbs: TbsInput, signingKey: KeyObject): string {
  const algorithm = seq(oid(OID.ecdsaWithSha256));
  const tbsDer = seq(
    explicit(0, integer(Buffer.of(2))), // v3
    integer(tbs.serial),
    algorithm,
    tbs.issuer,
    seq(time(tbs.notBefore), time(tbs.notAfter)),
    tbs.subject,
    tbs.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...tbs.extensions)),
  );
  const signature = sign('sha256', tbsDer, { key: signingKey, dsaEncoding: 'der' });
  const der = seq(tbsDer, algorithm, bitString(signature));
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function serialNumber(): Buffer {
  const b = randomBytes(16);
  b[0] = (b[0] ?? 0) & 0x7f; // positive
  return b;
}

// ------------------------------------------------------------------ the two certificates

export interface IssuedKeyPair {
  certificatePem: string;
  /** PKCS#8 PEM; encrypted with AES-256 when a passphrase was given. */
  privateKeyPem: string;
}

export interface RootCaOptions {
  commonName?: string;
  organization?: string;
  now?: Date;
  years?: number;
  /** Encrypts the private key (it leaves the PC on the owner's USB key). */
  passphrase: string;
}

export function createRootCa(options: RootCaOptions): IssuedKeyPair {
  if (options.passphrase.length < 12)
    throw new Error('The CA passphrase must have at least 12 characters');
  const now = options.now ?? new Date();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subject = name(
    options.commonName ?? 'Coffee Lounge Root CA',
    options.organization ?? 'Coffee Lounge',
  );
  const ski = keyId(publicKey);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (options.years ?? ROOT_CA_YEARS));
  const certificatePem = certificate(
    {
      serial: serialNumber(),
      issuer: subject,
      subject,
      notBefore: new Date(now.getTime() - DAY_MS), // tolerate a slow clock on devices
      notAfter,
      publicKey,
      extensions: [
        extension(OID.basicConstraints, true, seq(bool(true), integer(Buffer.of(0)))),
        extension(OID.keyUsage, true, bitString(Buffer.of(0x06), 1)), // keyCertSign, cRLSign
        extension(OID.subjectKeyId, false, octets(ski)),
      ],
    },
    privateKey,
  );
  return {
    certificatePem,
    privateKeyPem: privateKey
      .export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: options.passphrase,
      })
      .toString(),
  };
}

export interface ServerCertOptions {
  caCertificatePem: string;
  caPrivateKeyPem: string;
  caPassphrase: string;
  /** IPv4 addresses (the shop address and 127.0.0.1). */
  ips: readonly string[];
  dnsNames?: readonly string[];
  days?: number;
  now?: Date;
}

export function issueServerCertificate(options: ServerCertOptions): IssuedKeyPair {
  const days = options.days ?? SERVER_CERT_DAYS;
  if (days < 1 || days > MAX_SERVER_CERT_DAYS) {
    throw new Error(`Server certificates may be valid for 1–${String(MAX_SERVER_CERT_DAYS)} days`);
  }
  if (options.ips.length === 0) throw new Error('At least one IP address is required');
  const ca = new X509Certificate(options.caCertificatePem);
  if (!ca.ca) throw new Error('The CA certificate is not a certificate authority');
  const caKey = createPrivateKey({
    key: options.caPrivateKeyPem,
    passphrase: options.caPassphrase,
  });
  if (!ca.checkPrivateKey(caKey))
    throw new Error('The CA key does not belong to the CA certificate');

  const now = options.now ?? new Date();
  const notAfter = new Date(now.getTime() + days * DAY_MS);
  if (notAfter > new Date(ca.validTo))
    throw new Error('The CA certificate expires before the new certificate would');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caDer = ca.raw;
  // The issuer Name is copied byte for byte from the CA certificate's subject.
  const issuer = subjectOf(caDer);
  const sans = [
    ...options.ips.map((ip) => tlv(0x87, ipBytes(ip))), // [7] iPAddress
    ...(options.dnsNames ?? []).map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))), // [2] dNSName
  ];
  const primary = options.ips[0] ?? '';
  const certificatePem = certificate(
    {
      serial: serialNumber(),
      issuer,
      subject: name(primary, 'Coffee Lounge'),
      notBefore: new Date(now.getTime() - DAY_MS),
      notAfter,
      publicKey,
      extensions: [
        extension(OID.basicConstraints, true, seq()),
        extension(OID.keyUsage, true, bitString(Buffer.of(0x80), 7)), // digitalSignature
        extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, seq(...sans)),
        extension(OID.subjectKeyId, false, octets(keyId(publicKey))),
        extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId(ca.publicKey)))),
      ],
    },
    caKey,
  );
  return {
    certificatePem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// ------------------------------------------------------------------ minimal DER reading

/** Reads one TLV at `offset`: returns where its content starts and ends. */
function readTlv(der: Buffer, offset: number): { tag: number; start: number; end: number } {
  const tag = der[offset] ?? 0;
  let len = der[offset + 1] ?? 0;
  let start = offset + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + (der[start + i] ?? 0);
    start += count;
  }
  return { tag, start, end: start + len };
}

/** The subject Name of a certificate, exactly as encoded. */
function subjectOf(der: Buffer): Buffer {
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.start);
  let at = tbs.start;
  const fields: { start: number; end: number; tag: number; headerStart: number }[] = [];
  while (at < tbs.end) {
    const field = readTlv(der, at);
    fields.push({ ...field, headerStart: at });
    at = field.end;
  }
  // version [0], serial, signature, issuer, validity, subject
  const subject = fields[0]?.tag === 0xa0 ? fields[5] : fields[4];
  if (!subject) throw new Error('Unreadable CA certificate');
  return der.subarray(subject.headerStart, subject.end);
}

export function describeCertificate(pem: string): {
  subject: string;
  issuer: string;
  subjectAltName: string | undefined;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  ca: boolean;
} {
  const c = new X509Certificate(pem);
  return {
    subject: c.subject,
    issuer: c.issuer,
    subjectAltName: c.subjectAltName,
    validFrom: c.validFrom,
    validTo: c.validTo,
    fingerprint256: c.fingerprint256,
    ca: c.ca,
  };
}

/** Public key in PEM, e.g. to compare with a key file. */
export function publicKeyOf(privateKeyPem: string, passphrase?: string): string {
  return createPublicKey(
    createPrivateKey(passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem),
  )
    .export({ type: 'spki', format: 'pem' })
    .toString();
}
