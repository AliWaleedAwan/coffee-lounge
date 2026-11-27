export const PART_NAMES: string[];
export const META_FILES: string[];
export function hashPart(dir: string): string;
export function hashBundle(bundle: string): Record<string, string>;
export function partsText(
  version: string,
  parts: { name: string; hash: string; sha256: string; size: number; url: string }[],
): string;
export function packBundle(
  bundle: string,
  outDir: string,
): Promise<{ name: string; hash: string; file: string; sha256: string; size: number }[]>;
export function unpack(archive: string, dest: string): Promise<void>;
