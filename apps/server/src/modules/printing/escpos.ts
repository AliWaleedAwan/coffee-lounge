/**
 * ESC/POS bytes for an 80 mm receipt printer (PRINTING_HARDWARE.md §3): Font A, 48
 * characters a line, code page CP437 (to be confirmed on the self-test page), partial cut.
 * Only the common Epson subset is used, so any compatible printer understands it.
 * Text that CP437 cannot show becomes plain ASCII ("×" → "x") or "?": never control bytes.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** CP437 0x80–0xFF. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
// Every CP437 character is one code point, so a code-point split is exact here.
const HIGH = new Map(Array.from(CP437_HIGH, (ch, i) => [ch, 0x80 + i]));
const FALLBACK: Record<string, string> = {
  '×': 'x',
  '–': '-',
  '—': '-',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '✓': 'v',
  '•': '·',
};

/** Printable text only: control characters (and anything CP437 lacks) never reach the printer. */
export function toPrintable(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code < 0x7f) out += ch;
    else if (HIGH.has(ch)) out += ch;
    else if (FALLBACK[ch] !== undefined) out += FALLBACK[ch];
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) out += ' ';
    else out += '?';
  }
  return out;
}

function encode(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of toPrintable(text)) {
    const code = ch.codePointAt(0) ?? 0x3f;
    bytes.push(code < 0x80 ? code : (HIGH.get(ch) ?? 0x3f));
  }
  return bytes;
}

export type Align = 'left' | 'center' | 'right';

/** One printed line as the paper shows it: for on-screen previews (receipt design). */
export interface PreviewLine {
  text: string;
  align: Align;
  bold: boolean;
  wide: boolean;
  tall: boolean;
}

export class EscPos {
  private readonly out: number[] = [ESC, 0x40, ESC, 0x74, 0]; // initialise; code page 0 = CP437
  private readonly shown: PreviewLine[] = [];
  private state = { align: 'left' as Align, bold: false, wide: false, tall: false };

  line(text = ''): this {
    this.out.push(...encode(text), LF);
    this.shown.push({ text: toPrintable(text), ...this.state });
    return this;
  }

  bold(on: boolean): this {
    this.out.push(ESC, 0x45, on ? 1 : 0);
    this.state.bold = on;
    return this;
  }

  /** Double width and/or height (GS !). */
  size(double: { width?: boolean; height?: boolean }): this {
    this.out.push(GS, 0x21, (double.width ? 0x10 : 0) | (double.height ? 0x01 : 0));
    this.state.wide = Boolean(double.width);
    this.state.tall = Boolean(double.height);
    return this;
  }

  align(a: Align): this {
    this.out.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
    this.state.align = a;
    return this;
  }

  /** The lines printed so far, with their alignment and emphasis. */
  preview(): PreviewLine[] {
    return this.shown.map((l) => ({ ...l }));
  }

  feed(lines: number): this {
    this.out.push(ESC, 0x64, Math.max(0, Math.min(255, lines)));
    return this;
  }

  /** Feed past the cutter, then a partial cut (GS V 66 n). */
  cut(canCut: boolean): this {
    if (canCut) this.out.push(GS, 0x56, 66, 3);
    else this.feed(5);
    return this;
  }

  bytes(): Buffer {
    return Buffer.from(this.out);
  }
}

// ---------------------------------------------------------------- layout helpers

/** `left` and `right` on one line of `width`, right flush; `left` is cut if both do not fit. */
export function twoCols(left: string, right: string, width: number): string {
  const r = toPrintable(right);
  const room = Math.max(0, width - r.length - 1);
  const l = toPrintable(left);
  const shown = l.length > room ? l.slice(0, Math.max(0, room)) : l;
  return shown + ' '.repeat(Math.max(1, width - shown.length - r.length)) + r;
}

/** Words wrapped at `width`; continuation lines start with `indent`. Long words are split. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const lines: string[] = [];
  let current = '';
  const limit = () => Math.max(1, lines.length === 0 ? width : width - indent.length);
  for (const word of toPrintable(text).split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest !== '') {
      const joined = current === '' ? rest : `${current} ${rest}`;
      if (joined.length <= limit()) {
        current = joined;
        rest = '';
      } else if (current !== '') {
        lines.push(current);
        current = '';
      } else {
        lines.push(rest.slice(0, limit()));
        rest = rest.slice(limit());
      }
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current);
  return lines.map((l, i) => (i === 0 ? l : indent + l));
}

export const rule = (width: number, ch = '-') => ch.repeat(width);

/** "1300.00" → "1,300.00". */
export function amount(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = '00'] = value.replace('-', '').split('.');
  return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}

/** `left` and `right` on one line if they fit; otherwise `left` (wrapped), then `right` flush right. */
export function columns(left: string, right: string, width: number): string[] {
  const l = toPrintable(left);
  const r = toPrintable(right);
  if (l.length + r.length + 1 <= width) return [twoCols(l, r, width)];
  return [...wrap(l, width), ...(r ? [r.padStart(width)] : [])];
}
