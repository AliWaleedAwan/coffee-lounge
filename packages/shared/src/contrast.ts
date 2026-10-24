/**
 * WCAG 2.1 contrast (UI_UX.md "Branding", AT-130): the owner's brand colour is used for
 * button backgrounds under white text and for text on the light page, so both pairs must
 * reach AA for normal text (4.5:1). The browser checks it live; the server refuses a
 * colour that fails.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) throw new RangeError('colours are #rrggbb');
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The light surfaces brand-coloured text sits on (tokens.css). */
export const BRAND_BACKGROUNDS = ['#FFFFFF', '#FAF7F2'] as const;
export const AA_NORMAL_TEXT = 4.5;

/** Why a brand colour cannot be used, or null if it reads well everywhere it appears. */
export function brandColourProblem(hex: string): string | null {
  if (!HEX.test(hex)) return 'Use a colour like #6B4435';
  const onButton = contrastRatio(hex, '#FFFFFF');
  const onPage = Math.min(...BRAND_BACKGROUNDS.map((bg) => contrastRatio(hex, bg)));
  const worst = Math.min(onButton, onPage);
  if (worst >= AA_NORMAL_TEXT) return null;
  return `Too light: white button text on it reaches ${worst.toFixed(2)}:1; at least 4.5:1 is needed. Choose a darker colour.`;
}
