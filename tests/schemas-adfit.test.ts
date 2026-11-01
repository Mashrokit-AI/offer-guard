import { describe, expect, it } from 'vitest';
import { qaVerdictSchema, templateSpecSchema } from '../src/shared/schemas.js';
import { normalizeTemplateSpec, specBoxesNormalized } from '../src/server/models/template-read.js';

const VALID_SPEC = {
  logo: { box: { x: 0.78, y: 0.03, w: 0.17, h: 0.08 }, corner: 'top-right' },
  headline_zone: { x: 0.07, y: 0.74, w: 0.86, h: 0.1 },
  subtext_zone: null,
  panel_zone: { box: { x: 0.08, y: 0.76, w: 0.84, h: 0.16 }, color: '#ff5a3c', shape: 'rounded_rect' },
  product_zone: { x: 0.3, y: 0.15, w: 0.4, h: 0.55 },
  frames: [{ box: { x: 0, y: 0.79, w: 1, h: 0.21 }, color: '#0f4c5c', edge: 'bottom', kind: 'band' }],
  background_style: 'teal gradient with bottom band',
  text_align: 'center',
  direction: 'rtl',
};

describe('template spec schema', () => {
  it('parses a valid spec', () => {
    expect(templateSpecSchema.parse(VALID_SPEC).frames).toHaveLength(1);
  });

  it('rejects bad colors but lets pixel boxes through to normalization', () => {
    // Pixel-scale boxes must PARSE (the model sometimes answers in pixels);
    // normalizeTemplateSpec converts them before anything is stored.
    const pixels = templateSpecSchema.parse({ ...VALID_SPEC, headline_zone: { x: 0, y: 0, w: 200, h: 100 } });
    expect(pixels.headline_zone?.w).toBe(200);
    expect(specBoxesNormalized(templateSpecSchema.parse(VALID_SPEC))).toBe(true);
    expect(specBoxesNormalized(pixels)).toBe(false);
    expect(() =>
      templateSpecSchema.parse({ ...VALID_SPEC, panel_zone: { ...VALID_SPEC.panel_zone, color: 'red' } }),
    ).toThrow();
  });

  it('passes unit boxes through and converts pixel boxes to 0-1', () => {
    const unit = normalizeTemplateSpec(templateSpecSchema.parse(VALID_SPEC), 1080, 1920);
    expect(unit.panel_zone?.box.x).toBeCloseTo(0.08, 6);
    const pixels = normalizeTemplateSpec(
      templateSpecSchema.parse({
        ...VALID_SPEC,
        headline_zone: { x: 75.6, y: 1420.8, w: 928.8, h: 192 },
        panel_zone: null,
        product_zone: null,
        logo: null,
        frames: [],
      }),
      1080,
      1920,
    );
    // 75.6/1080 ≈ 0.07 — pixel input detected and normalized (via integer pixels).
    expect(pixels.headline_zone?.x).toBeCloseTo(0.07, 2);
  });
});

describe('QA verdict schema', () => {
  const VALID_QA = {
    pass: true,
    reasons: [],
    texts_read: [{ expected: '20% הנחה', found: '20% הנחה', exact: true }],
    logo_ok: true,
    product_ok: true,
    safe_area_ok: true,
    invented_text: [],
  };

  it('parses a passing verdict', () => {
    expect(qaVerdictSchema.parse(VALID_QA).pass).toBe(true);
  });

  it('parses a failing verdict with reasons', () => {
    const v = qaVerdictSchema.parse({
      ...VALID_QA,
      pass: false,
      reasons: ['headline letter changed'],
      texts_read: [{ expected: 'a', found: 'b', exact: false }],
      invented_text: ['SALE'],
    });
    expect(v.pass).toBe(false);
    expect(v.invented_text).toEqual(['SALE']);
  });

  it('rejects missing verdict fields', () => {
    const { pass: _p, ...rest } = VALID_QA;
    expect(() => qaVerdictSchema.parse(rest)).toThrow();
  });
});
