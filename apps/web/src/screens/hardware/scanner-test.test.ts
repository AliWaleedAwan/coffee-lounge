import { describe, expect, it } from 'vitest';
import { readScan } from './scanner-test.ts';

describe('the scanner test', () => {
  it('names the common retail barcodes and checks their last digit', () => {
    expect(readScan('5901234123457')).toEqual({
      code: '5901234123457',
      type: 'EAN-13',
      checkOk: true,
    });
    expect(readScan('96385074')).toMatchObject({ type: 'EAN-8', checkOk: true });
    expect(readScan('036000291452')).toMatchObject({ type: 'UPC-A', checkOk: true });
  });

  it('catches a misread digit', () => {
    expect(readScan('5901234123458')).toMatchObject({ type: 'EAN-13', checkOk: false });
  });

  it('calls anything else another barcode, and ignores stray spaces', () => {
    expect(readScan(' ABC-123 ')).toMatchObject({ code: 'ABC-123', checkOk: true });
    expect(readScan('12345').type).toMatch(/^Other/);
  });
});
