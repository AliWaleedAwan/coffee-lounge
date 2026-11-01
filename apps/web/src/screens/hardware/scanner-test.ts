/** What the Test scanner box reports about one scan (Phase 8 step 8.6). Pure, so it can be tested. */

/** The standard GS1 check digit: the weights alternate 3, 1 from the right, before the check. */
function checkDigitOk(digits: string): boolean {
  const body = digits.slice(0, -1).split('').reverse();
  const sum = body.reduce((total, d, i) => total + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

const NUMERIC: Readonly<Record<number, string>> = {
  8: 'EAN-8',
  12: 'UPC-A',
  13: 'EAN-13',
  14: 'ITF-14',
};

export interface ScanVerdict {
  code: string;
  /** A best guess from the digits: the scanner does not say which symbol it read. */
  type: string;
  /** False when the digits fail their own check: a misread, or the scanner dropping digits. */
  checkOk: boolean;
}

export function readScan(raw: string): ScanVerdict {
  const code = raw.trim();
  const type = /^\d+$/.test(code) ? NUMERIC[code.length] : undefined;
  if (type) return { code, type, checkOk: checkDigitOk(code) };
  return { code, type: 'Other barcode (such as Code 128)', checkOk: true };
}
