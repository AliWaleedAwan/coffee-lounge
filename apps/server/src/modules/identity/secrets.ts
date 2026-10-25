/**
 * Password and PIN hashing with argon2id (SECURITY.md §2.2), using Node's built-in
 * implementation (no native add-on to build on Windows). Hashes are stored in PHC
 * format so parameters can be raised later without invalidating existing hashes.
 * Also: session/device tokens and registration codes.
 */
import { argon2, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** OWASP-recommended minimum for argon2id: 19 MiB memory, 2 passes, 1 lane. */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

function derive(
  secret: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: secret, nonce: salt, ...params }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(secret, salt, PARAMS);
  return `$argon2id$v=19$m=${String(PARAMS.memory)},t=${String(PARAMS.passes)},p=${String(PARAMS.parallelism)}$${b64(salt)}$${b64(key)}`;
}

export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const [, m, t, p, saltB64, keyB64] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await derive(secret, Buffer.from(saltB64, 'base64'), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash of a random value, verified when a username does not exist, so timing reveals nothing. */
let dummyHash: Promise<string> | undefined;
export function verifyAgainstDummy(secret: string): Promise<boolean> {
  dummyHash ??= hashSecret(randomBytes(16).toString('hex'));
  return dummyHash.then((h) => verifySecret(secret, h)).then(() => false);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  return null;
}

/** 4–6 digits, not all the same digit, not a straight run like 1234 or 9876. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4 to 6 digits';
  if (/^(\d)\1+$/.test(pin)) return 'PIN must not repeat one digit';
  const digits = Array.from(pin, Number);
  const steps = digits.slice(1).map((d, i) => d - (digits[i] ?? 0));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return 'PIN must not be a simple sequence';
  }
  return null;
}

/** Opaque bearer token (cookie value) and the hash stored in the database. */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Eight-digit one-time device registration code. */
export function newRegistrationCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

/** Owner recovery code: 4 groups of 5 characters (~100 bits), no look-alike characters. */
export function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 5 }, () => alphabet[randomInt(0, alphabet.length)] ?? 'A').join(''),
  );
  return groups.join('-');
}
