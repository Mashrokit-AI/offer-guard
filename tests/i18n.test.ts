import { describe, expect, it } from 'vitest';
import { STRINGS, parseLang, presetName, t } from '../src/shared/i18n.js';
import { PRESETS } from '../src/shared/presets.js';
import { BRAND_NAME } from '../src/shared/brand.js';

describe('i18n', () => {
  it('has exact key parity between English and Hebrew', () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    const heKeys = Object.keys(STRINGS.he).sort();
    expect(heKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(50);
    for (const k of enKeys) {
      expect(STRINGS.en[k as keyof typeof STRINGS.en].length).toBeGreaterThan(0);
      expect(STRINGS.he[k as keyof typeof STRINGS.he].length).toBeGreaterThan(0);
    }
  });

  it('fills {vars} and throws on unknown keys', () => {
    expect(t('en', 'proof_row', { what: 'logo', diff: 0, scale: '1.00' })).toContain('logo');
    expect(t('he', 'qa_pass')).toBeTruthy();
    expect(() => t('en', 'no_such_key' as never)).toThrow(/unknown message key/);
  });

  it('localizes all 8 preset names, falls back to the server label', () => {
    expect(presetName('he', 'ig-feed-11', 'Instagram feed 1:1')).toBe('פיד אינסטגרם 1:1');
    expect(presetName('en', 'tiktok-916', 'TikTok 9:16')).toBe('TikTok 9:16');
    for (const p of PRESETS) {
      const heName = presetName('he', p.id, p.label);
      expect(heName.length).toBeGreaterThan(0);
      expect(heName).not.toBe(p.label); // a real translation, not the fallback
    }
    expect(presetName('he', 'future-preset', 'Server Label')).toBe('Server Label');
  });

  it('parses --lang he, defaults to English', () => {
    expect(parseLang(['--lang', 'he'])).toBe('he');
    expect(parseLang([])).toBe('en');
    expect(parseLang(['--lang', 'fr'])).toBe('en');
  });

  it('keeps the product name in exactly one place', () => {
    expect(BRAND_NAME.length).toBeGreaterThan(0);
    // Rename-proof: whatever the name is, no copy may hide in the strings.
    const joined = Object.values(STRINGS.en).join('\n');
    expect(joined).not.toContain(BRAND_NAME);
  });
});
