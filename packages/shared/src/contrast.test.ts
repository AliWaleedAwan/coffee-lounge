import { describe, expect, it } from 'vitest';
import { brandColourProblem, contrastRatio } from './contrast.ts';

describe('brand colour contrast (AT-130)', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });

  it('accepts the default coffee and other dark colours, refuses light ones', () => {
    expect(brandColourProblem('#6B4435')).toBeNull();
    expect(brandColourProblem('#1F4E79')).toBeNull();
    expect(brandColourProblem('#F2C94C')).toMatch(/^Too light: .* reaches 1\.\d\d:1/);
    expect(brandColourProblem('#9A563E')).toBeNull(); // terracotta, the accent: 5.9:1
    expect(brandColourProblem('coffee')).toBe('Use a colour like #6B4435');
  });
});
