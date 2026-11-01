import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateSpecSchema, type NormBox, type TemplateSpec } from '../src/shared/schemas.js';
import { sanitizeTemplateSpec, specBoxesNormalized } from '../src/server/models/template-read.js';

const SPECS: Array<[string, string]> = [
  ['gali', 'spec-1x1.json'],
  ['gali', 'spec-4x5.json'],
  ['gali', 'spec-9x16.json'],
  ['gali', 'spec-1.91x1.json'],
  ['noa', 'spec-1x1.json'],
  ['noa', 'spec-9x16.json'],
  ['vela', 'spec-1x1.json'],
  ['vela', 'spec-1.91x1.json'],
  ['vela', 'spec-9x16.json'],
  ['dafna', 'spec-1x1.json'],
  ['dafna', 'spec-1.91x1.json'],
  ['dafna', 'spec-9x16.json'],
];

function load(brand: string, file: string): TemplateSpec {
  const p = join(process.cwd(), 'fixtures', 'brands', brand, file);
  return templateSpecSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
}

function overlapFrac(a: NormBox, b: NormBox): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (w * h) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
}

describe('sanitizeTemplateSpec', () => {
  it('clamps out-of-range boxes and drops degenerate ones', () => {
    const base = load('gali', 'spec-1x1.json');
    const { spec, fixes } = sanitizeTemplateSpec({
      ...base,
      product_zone: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },
      subtext_zone: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 },
    });
    expect((spec.product_zone?.x ?? 0) + (spec.product_zone?.w ?? 0)).toBeLessThanOrEqual(1);
    expect(spec.product_zone?.w).toBeLessThanOrEqual(0.1);
    expect(spec.subtext_zone).toBeNull();
    expect(fixes.length).toBeGreaterThan(0);
  });

  it('keeps panel-nested text but resolves logo/product collisions', () => {
    const base = load('gali', 'spec-1x1.json');
    const panel = base.panel_zone!.box;
    const { spec, fixes } = sanitizeTemplateSpec({
      ...base,
      // Headline slightly overflows the panel: pulled strictly inside.
      headline_zone: { x: panel.x - 0.02, y: panel.y, w: panel.w * 0.9, h: panel.h * 0.4 },
      // Logo pasted on top of the product: shrunk away.
      logo: { box: { ...base.product_zone! }, corner: 'other' },
    });
    expect(spec.headline_zone!.x).toBeGreaterThanOrEqual(panel.x - 1e-9);
    expect(overlapFrac(spec.logo!.box, spec.product_zone!)).toBeLessThan(0.9);
    expect(fixes.join(' ')).toMatch(/panel|logo/);
  });
});

describe('committed template specs', () => {
  it.each(SPECS)('%s %s is normalized and already sanitized', (brand, file) => {
    const spec = load(brand, file);
    expect(specBoxesNormalized(spec)).toBe(true);
    const { fixes } = sanitizeTemplateSpec(spec);
    expect(fixes).toEqual([]);
  });

  it.each(SPECS)('%s %s has no unintended zone overlaps', (brand, file) => {
    const spec = load(brand, file);
    const pairs: Array<[string, NormBox | null, string, NormBox | null]> = [
      ['logo', spec.logo?.box ?? null, 'product', spec.product_zone],
      ['logo', spec.logo?.box ?? null, 'panel', spec.panel_zone?.box ?? null],
      ['product', spec.product_zone, 'panel', spec.panel_zone?.box ?? null],
    ];
    for (const [an, a, bn, b] of pairs) {
      if (!a || !b) continue;
      expect(overlapFrac(a, b), `${brand}/${file} ${an} vs ${bn}`).toBeLessThanOrEqual(0.05);
    }
    // Free (non-panel-nested) text zones must not cover the product or logo.
    for (const [label, zone] of [['headline', spec.headline_zone], ['subtext', spec.subtext_zone]] as const) {
      if (!zone) continue;
      const inPanel = spec.panel_zone ? overlapFrac(zone, spec.panel_zone.box) > 0.5 : false;
      if (inPanel) continue;
      if (spec.product_zone) expect(overlapFrac(zone, spec.product_zone), `${brand}/${file} ${label} vs product`).toBeLessThanOrEqual(0.05);
      if (spec.logo) expect(overlapFrac(zone, spec.logo.box), `${brand}/${file} ${label} vs logo`).toBeLessThanOrEqual(0.05);
    }
  });

  it('panel boxes match the pixel-measured template art', () => {
    // Measured from the template PNGs (orange/dark region edges); tolerance 0.01.
    const expected: Record<string, NormBox> = {
      'gali/spec-1x1.json': { x: 0.083, y: 0.778, w: 0.833, h: 0.157 },
      'gali/spec-4x5.json': { x: 0.083, y: 0.793, w: 0.833, h: 0.141 },
      'gali/spec-9x16.json': { x: 0.102, y: 0.646, w: 0.796, h: 0.104 },
      'gali/spec-1.91x1.json': { x: 0.444, y: 0.508, w: 0.497, h: 0.15 },
      'noa/spec-1x1.json': { x: 0.083, y: 0.759, w: 0.833, h: 0.176 },
      'noa/spec-9x16.json': { x: 0.102, y: 0.828, w: 0.796, h: 0.115 },
    };
    for (const [key, want] of Object.entries(expected)) {
      const [brand, file] = key.split('/') as [string, string];
      const got = load(brand, file).panel_zone?.box;
      expect(got, key).toBeDefined();
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        expect(Math.abs((got?.[k] ?? 0) - want[k]), `${key}.${k}`).toBeLessThanOrEqual(0.01);
      }
    }
  });
});
