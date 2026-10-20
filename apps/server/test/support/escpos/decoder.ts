/**
 * ESC/POS decoder for tests (PRINTING_HARDWARE.md §3): turns the bytes a printer would
 * receive into printed text lines plus a record of every command. Golden tests in later
 * phases compare `lines`; safety tests check `drawerKicks` (no drawer, D-03) and that
 * nothing is `unknown`. Covers the Epson TM command subset that receipt printers share.
 */

export type Align = 'left' | 'center' | 'right';

export interface Style {
  bold: boolean;
  underline: boolean;
  doubleWidth: boolean;
  doubleHeight: boolean;
  align: Align;
}

export interface PrintedLine {
  text: string;
  style: Style;
}

export type DecodedEvent =
  | { type: 'line'; text: string }
  | { type: 'command'; name: string; args: number[]; offset: number };

export interface Decoded {
  /** Printed lines (each ended by LF, a feed or a cut), in order. */
  lines: PrintedLine[];
  /** The lines' text joined with "\n" (handy for snapshots). */
  text: string;
  cuts: { kind: 'full' | 'partial'; feedLines: number; afterLine: number }[];
  /** Cash drawer pulses (ESC p, DLE DC4 1). The shop has no drawer, so this must stay 0. */
  drawerKicks: number;
  images: { kind: 'raster' | 'bit-image' | 'nv'; widthDots: number; heightDots: number }[];
  barcodes: { kind: '1d' | '2d'; data: string }[];
  /** Real-time status requests (DLE EOT n, GS r n) seen in the stream. */
  statusRequests: { command: 'DLE EOT' | 'GS r'; n: number }[];
  codePage: number;
  unknown: { offset: number; bytes: number[]; reason: string }[];
  events: DecodedEvent[];
}

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const FS = 0x1c;
const LF = 0x0a;

/** CP437 upper half (the printer's usual default code page). */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const cp1252 = new TextDecoder('windows-1252');

function charFor(byte: number, codePage: number): string {
  if (byte < 0x80) return String.fromCharCode(byte);
  if (codePage === 16) return cp1252.decode(Uint8Array.of(byte));
  return CP437_HIGH[byte - 0x80] ?? '?';
}

const defaultStyle = (): Style => ({
  bold: false,
  underline: false,
  doubleWidth: false,
  doubleHeight: false,
  align: 'left',
});

class Truncated extends Error {}

export function decodeEscPos(input: Uint8Array): Decoded {
  const b = input;
  const out: Decoded = {
    lines: [],
    text: '',
    cuts: [],
    drawerKicks: 0,
    images: [],
    barcodes: [],
    statusRequests: [],
    codePage: 0,
    unknown: [],
    events: [],
  };
  let style = defaultStyle();
  let current = '';
  let lineStyle: Style | null = null;
  let i = 0;

  const need = (count: number): void => {
    if (i + count > b.length) throw new Truncated();
  };
  const arg = (offset: number): number => b[i + offset] ?? 0;
  const command = (name: string, length: number, start: number): void => {
    out.events.push({
      type: 'command',
      name,
      args: [...b.subarray(start + 2, start + length)],
      offset: start,
    });
  };
  const endLine = (): void => {
    out.lines.push({ text: current, style: lineStyle ?? { ...style } });
    out.events.push({ type: 'line', text: current });
    current = '';
    lineStyle = null;
  };
  const flush = (): void => {
    if (current !== '') endLine();
  };

  while (i < b.length) {
    const start = i;
    const byte = b[i] ?? 0;
    try {
      if (byte === LF) {
        endLine();
        i += 1;
      } else if (byte === 0x0d) {
        i += 1; // CR: ignored by most printers in LF mode
      } else if (byte === 0x09) {
        current += '\t';
        i += 1;
      } else if (byte >= 0x20 && byte !== 0x7f) {
        lineStyle ??= { ...style };
        current += charFor(byte, out.codePage);
        i += 1;
      } else if (byte === ESC) {
        need(2);
        const c = arg(1);
        switch (c) {
          case 0x40: // ESC @ initialise
            flush();
            style = defaultStyle();
            out.codePage = 0;
            command('init', 2, start);
            i += 2;
            break;
          case 0x21: {
            need(3);
            const n = arg(2);
            style = {
              ...style,
              bold: (n & 0x08) !== 0,
              doubleHeight: (n & 0x10) !== 0,
              doubleWidth: (n & 0x20) !== 0,
              underline: (n & 0x80) !== 0,
            };
            command('print-mode', 3, start);
            i += 3;
            break;
          }
          case 0x45: // ESC E bold
            need(3);
            style = { ...style, bold: (arg(2) & 1) === 1 };
            command('bold', 3, start);
            i += 3;
            break;
          case 0x2d: // ESC - underline
            need(3);
            style = { ...style, underline: arg(2) % 48 !== 0 };
            command('underline', 3, start);
            i += 3;
            break;
          case 0x61: {
            // ESC a align
            need(3);
            const n = arg(2) % 48;
            style = { ...style, align: n === 1 ? 'center' : n === 2 ? 'right' : 'left' };
            command('align', 3, start);
            i += 3;
            break;
          }
          case 0x64: {
            // ESC d n: print and feed n lines
            need(3);
            flush();
            for (let k = 0; k < arg(2); k++) endLine();
            command('feed-lines', 3, start);
            i += 3;
            break;
          }
          case 0x4a: // ESC J n: print and feed dots
            need(3);
            flush();
            command('feed-dots', 3, start);
            i += 3;
            break;
          case 0x74: // ESC t code page
            need(3);
            out.codePage = arg(2);
            command('code-page', 3, start);
            i += 3;
            break;
          case 0x70: // ESC p m t1 t2: drawer kick
            need(5);
            out.drawerKicks += 1;
            command('drawer-kick', 5, start);
            i += 5;
            break;
          case 0x32: // ESC 2 default line spacing
            command('line-spacing-default', 2, start);
            i += 2;
            break;
          case 0x33: // ESC 3 n
          case 0x4d: // ESC M font
          case 0x47: // ESC G double strike
          case 0x52: // ESC R international set
          case 0x7b: // ESC { upside down
          case 0x56: // ESC V rotate
          case 0x20: // ESC SP right spacing
          case 0x63: // ESC c 5 panel buttons (ESC c 5 n)
            need(c === 0x63 ? 4 : 3);
            command(`ESC ${String.fromCharCode(c)}`, c === 0x63 ? 4 : 3, start);
            i += c === 0x63 ? 4 : 3;
            break;
          case 0x24: // ESC $ nL nH absolute position
            need(4);
            command('position', 4, start);
            i += 4;
            break;
          case 0x2a: {
            // ESC * m nL nH d…: bit image
            need(5);
            const m = arg(2);
            const columns = arg(3) + arg(4) * 256;
            const size = columns * (m === 32 || m === 33 ? 3 : 1);
            need(5 + size);
            flush();
            out.images.push({
              kind: 'bit-image',
              widthDots: columns,
              heightDots: m >= 32 ? 24 : 8,
            });
            command('bit-image', 5, start);
            i += 5 + size;
            break;
          }
          default:
            out.unknown.push({ offset: start, bytes: [ESC, c], reason: 'unsupported ESC command' });
            i += 2;
        }
      } else if (byte === GS) {
        need(2);
        const c = arg(1);
        switch (c) {
          case 0x21: {
            // GS ! size
            need(3);
            const n = arg(2);
            style = { ...style, doubleWidth: (n & 0x70) !== 0, doubleHeight: (n & 0x07) !== 0 };
            command('char-size', 3, start);
            i += 3;
            break;
          }
          case 0x56: {
            // GS V m [n]: cut
            need(3);
            const m = arg(2);
            const withFeed = m === 65 || m === 66;
            if (withFeed) need(4);
            flush();
            out.cuts.push({
              kind: m === 1 || m === 49 || m === 66 ? 'partial' : 'full',
              feedLines: withFeed ? arg(3) : 0,
              afterLine: out.lines.length,
            });
            command('cut', withFeed ? 4 : 3, start);
            i += withFeed ? 4 : 3;
            break;
          }
          case 0x42: // GS B reverse
          case 0x48: // GS H HRI position
          case 0x66: // GS f HRI font
          case 0x68: // GS h barcode height
          case 0x77: // GS w barcode width
          case 0x61: // GS a automatic status back
            need(3);
            command(`GS ${String.fromCharCode(c)}`, 3, start);
            i += 3;
            break;
          case 0x72: // GS r n: transmit status
            need(3);
            out.statusRequests.push({ command: 'GS r', n: arg(2) });
            command('status', 3, start);
            i += 3;
            break;
          case 0x4c: // GS L left margin
          case 0x57: // GS W print width
            need(4);
            command(`GS ${String.fromCharCode(c)}`, 4, start);
            i += 4;
            break;
          case 0x6b: {
            // GS k: barcode
            need(3);
            const m = arg(2);
            flush();
            if (m <= 6) {
              let end = i + 3;
              while (end < b.length && b[end] !== 0) end++;
              if (end >= b.length) throw new Truncated();
              out.barcodes.push({
                kind: '1d',
                data: String.fromCharCode(...b.subarray(i + 3, end)),
              });
              command('barcode', 3, start);
              i = end + 1;
            } else {
              need(4);
              const n = arg(3);
              need(4 + n);
              out.barcodes.push({
                kind: '1d',
                data: String.fromCharCode(...b.subarray(i + 4, i + 4 + n)),
              });
              command('barcode', 4, start);
              i += 4 + n;
            }
            break;
          }
          case 0x76: {
            // GS v 0 m xL xH yL yH d…: raster image
            need(8);
            const widthBytes = arg(4) + arg(5) * 256;
            const height = arg(6) + arg(7) * 256;
            need(8 + widthBytes * height);
            flush();
            out.images.push({ kind: 'raster', widthDots: widthBytes * 8, heightDots: height });
            command('raster-image', 8, start);
            i += 8 + widthBytes * height;
            break;
          }
          case 0x28: {
            // GS ( X pL pH …: function blocks (QR codes, graphics)
            need(5);
            const kind = arg(2);
            const length = arg(3) + arg(4) * 256;
            need(5 + length);
            const body = b.subarray(i + 5, i + 5 + length);
            // QR "store data" (cn 49, fn 80) carries the text after 3 bytes.
            if (kind === 0x6b && body[0] === 49 && body[1] === 80) {
              out.barcodes.push({ kind: '2d', data: String.fromCharCode(...body.subarray(3)) });
            }
            command(`GS ( ${String.fromCharCode(kind)}`, 5, start);
            i += 5 + length;
            break;
          }
          default:
            out.unknown.push({ offset: start, bytes: [GS, c], reason: 'unsupported GS command' });
            i += 2;
        }
      } else if (byte === DLE) {
        need(2);
        const c = arg(1);
        if (c === 0x04) {
          need(3);
          out.statusRequests.push({ command: 'DLE EOT', n: arg(2) });
          command('realtime-status', 3, start);
          i += 3;
        } else if (c === 0x14) {
          // DLE DC4 fn …: fn 1 = drawer pulse (3 more bytes); fn 2, 8 = 4 more bytes
          need(3);
          const fn = arg(2);
          const length = fn === 1 ? 5 : 7;
          need(length);
          if (fn === 1) out.drawerKicks += 1;
          command(fn === 1 ? 'drawer-kick' : 'realtime-request', length, start);
          i += length;
        } else if (c === 0x05) {
          need(3);
          command('realtime-request', 3, start);
          i += 3;
        } else {
          out.unknown.push({ offset: start, bytes: [DLE, c], reason: 'unsupported DLE command' });
          i += 2;
        }
      } else if (byte === FS) {
        need(2);
        const c = arg(1);
        if (c === 0x2e || c === 0x26) {
          command(c === 0x2e ? 'kanji-off' : 'kanji-on', 2, start);
          i += 2;
        } else if (c === 0x70) {
          need(4);
          flush();
          out.images.push({ kind: 'nv', widthDots: 0, heightDots: 0 });
          command('nv-image', 4, start);
          i += 4;
        } else {
          out.unknown.push({ offset: start, bytes: [FS, c], reason: 'unsupported FS command' });
          i += 2;
        }
      } else {
        out.unknown.push({ offset: start, bytes: [byte], reason: 'control character' });
        i += 1;
      }
    } catch (error) {
      if (!(error instanceof Truncated)) throw error;
      out.unknown.push({
        offset: start,
        bytes: [...b.subarray(start)],
        reason: 'truncated command',
      });
      i = b.length;
    }
  }
  flush();
  out.text = out.lines.map((l) => l.text).join('\n');
  return out;
}
