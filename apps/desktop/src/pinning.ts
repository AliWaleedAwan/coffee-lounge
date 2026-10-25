/**
 * Certificate pinning (SECURITY.md §2.7, LOCAL_LAN_HOSTING.md §5): for the shop server the
 * certificate chain must lead to the pinned shop root, whatever the operating system
 * trusts. The system trust store is never consulted for the server, and TLS checks are
 * never disabled. Every other host is refused outright: the app talks only to the server.
 */
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';

export type PinVerdict = { ok: true } | { ok: false; reason: string };

export interface PinInput {
  hostname: string;
  /** PEM certificates as presented by the server, leaf first. */
  chain: readonly string[];
}

export interface Pin {
  host: string;
  root: X509Certificate;
}

const MAX_DEPTH = 4;
/** Signatures no longer safe against forgery. */
const WEAK_SIGNATURE = /md2|md4|md5|sha1(?!\d)|sha-1/i;

/**
 * Chromium checks everything (dates, names, key usage, signature strength) and then finds
 * the root unknown: ERR_CERT_AUTHORITY_INVALID (-202) is the one failure pinning may
 * override. Chromium may report only its most severe error, so the checks below repeat
 * what matters rather than rely on this alone.
 */
export function chromiumAcceptable(errorCode: number): boolean {
  return errorCode === 0 || errorCode === -202;
}

function weak(cert: X509Certificate): boolean {
  // Node 24 exposes the algorithm; if it ever does not, treat the chain as unverifiable.
  const algorithm = (cert as { signatureAlgorithm?: unknown }).signatureAlgorithm;
  return typeof algorithm !== 'string' || WEAK_SIGNATURE.test(algorithm);
}

function within(cert: X509Certificate, now: Date): boolean {
  return new Date(cert.validFrom) <= now && now <= new Date(cert.validTo);
}

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
  return child.checkIssued(parent) && child.verify(parent.publicKey);
}

export function pinnedVerdict(input: PinInput, pin: Pin, now: Date = new Date()): PinVerdict {
  if (input.hostname !== pin.host) {
    return { ok: false, reason: `${input.hostname} is not the shop server` };
  }
  let chain: X509Certificate[];
  try {
    chain = input.chain.map((pem) => new X509Certificate(pem));
  } catch {
    return { ok: false, reason: 'unreadable certificate' };
  }
  const leaf = chain[0];
  if (!leaf) return { ok: false, reason: 'no certificate' };

  const nameMatches =
    isIP(pin.host) !== 0
      ? leaf.checkIP(pin.host) !== undefined
      : leaf.checkHost(pin.host) !== undefined;
  if (!nameMatches) return { ok: false, reason: `certificate is not for ${pin.host}` };
  if (!within(leaf, now)) return { ok: false, reason: 'certificate expired or not yet valid' };
  if (chain.some(weak)) return { ok: false, reason: 'certificate uses a weak signature' };

  let current = leaf;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (issuedBy(current, pin.root)) {
      return within(pin.root, now)
        ? { ok: true }
        : { ok: false, reason: 'shop root certificate expired' };
    }
    const parent = chain.find((c) => c !== current && c.ca && issuedBy(current, c));
    if (!parent || !within(parent, now)) break;
    current = parent;
  }
  return { ok: false, reason: 'certificate is not signed by the shop root' };
}

/** Flattens Electron's linked `issuerCert` chain into PEM strings, leaf first. */
export function chainOf(cert: { data: string; issuerCert?: unknown }): string[] {
  const out: string[] = [];
  let node: { data: string; issuerCert?: unknown } = cert;
  while (out.length < MAX_DEPTH + 1) {
    out.push(node.data);
    const next = node.issuerCert as { data: string; issuerCert?: unknown } | undefined;
    if (!next || next.data === node.data) break; // self-signed root points at itself
    node = next;
  }
  return out;
}
