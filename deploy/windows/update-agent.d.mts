export function isNewer(candidate: string, current: string): boolean;
export function signedText(m: { version: string; url: string; sha256: string }): string;
export function failureMessage(log: string): string;
export function tick(
  cfg: Record<string, string>,
  deps?: {
    fetchFn?: (url: string, init?: object) => Promise<Response>;
    install?: (file: string, args: string[]) => Promise<number>;
    now?: number;
  },
): Promise<void>;
export function verifiedParts(
  m: Record<string, unknown>,
  publicKeyPem: string,
): Promise<{ name: string; hash: string; sha256: string; size: number; url: string }[] | null>;
