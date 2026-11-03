import { describe, expect, test } from 'bun:test';
import { getBundledThemeFontStack } from './themeFonts';

describe('bundled theme fonts', () => {
  test('Olympus supplies Inter and other palettes supply nothing', () => {
    expect(getBundledThemeFontStack('olympus-dark')).toContain('"Inter"');
    expect(getBundledThemeFontStack('openchamber-dark')).toBeUndefined();
  });
});
