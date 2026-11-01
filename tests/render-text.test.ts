import { describe, expect, it } from 'vitest';
import { buildTextBlockHtml, isolateNumerals } from '../src/server/repair/render.js';
import { buildFastPrompt, buildPlatePrompt, type OutputRequest } from '../src/server/adfit/pipeline.js';
import { buildQaPrompt } from '../src/server/models/qa.js';
import { presetById } from '../src/shared/presets.js';
import { planLayout } from '../src/server/adfit/planner.js';
import type { PreparedSource } from '../src/server/adfit/pipeline.js';

describe('text block html', () => {
  it('keeps logical order with rtl dir and isolates numerals', () => {
    const html = buildTextBlockHtml({
      width: 400, height: 120, lang: 'he', align: 'center', fontCss: '', sizes: [60],
      lines: [{ text: '20% הנחה', px: 60, weight: 700, color: { r: 255, g: 255, b: 255 } }],
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('הנחה'); // logical string order, never reversed
    expect(html).toContain('<span dir="ltr"');
    expect(isolateNumerals('עד 10.11')).toContain('unicode-bidi:isolate');
  });

  it('escapes html in verbatim text', () => {
    const html = buildTextBlockHtml({
      width: 400, height: 120, lang: 'en', align: 'start', fontCss: '', sizes: [40],
      lines: [{ text: '<b>bold</b>', px: 40, weight: 400, color: { r: 0, g: 0, b: 0 } }],
    });
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

function fakeSource(): PreparedSource {
  const analysis = {
    language: 'he' as const,
    direction: 'rtl' as const,
    products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 1, y: 1, w: 10, h: 10 } }],
    logo_bbox: { x: 1, y: 1, w: 5, h: 5 },
    headline: { text: '20% הנחה', bbox: { x: 1, y: 1, w: 10, h: 4 }, bold: true, color: '#ffffff' },
    subtext: null,
    panel: { bbox: { x: 1, y: 1, w: 10, h: 6 }, opaque: true, bg_color: '#ff5a3c', text_color: '#ffffff', texts: ['עד 10.11'] },
    other_texts: [],
    background: { type: 'gradient' as const, description: 'teal gradient', colors: ['#e9f5f3'] },
    unreadable: [],
  };
  const rgba = { data: Buffer.alloc(10 * 10 * 4, 255), width: 10, height: 10 };
  return {
    id: 's', bytes: Buffer.alloc(10), mimeType: 'image/png', width: 10, height: 10, analysis,
    products: [{ id: 'product-0', rgba, srcX: 0, srcY: 0, fallbackRect: false }],
    logo: { id: 'logo', rgba, srcX: 0, srcY: 0, fallbackRect: false },
    panel: null, masks: new Map(), maskLabels: {}, modelCalls: 0,
  };
}

describe('image prompts', () => {
  const preset = presetById('ig-story-916')!;
  const source = fakeSource();
  const plan = planLayout({
    preset, source: source.analysis, sourceWidth: 10, sourceHeight: 10,
    productCuts: [{ w: 10, h: 10 }], logoCut: { w: 10, h: 10 }, template: null,
  });
  const req = { source, preset, mode: 'fast', template: null, framePng: null, brandName: 'GALI' } as OutputRequest;

  it('fast prompt lists every verbatim text and the layout', () => {
    const p = buildFastPrompt(req, plan, []);
    expect(p).toContain('20% הנחה');
    expect(p).toContain('עד 10.11');
    expect(p).toContain('1080x1920');
    expect(p).toContain('do not invent');
  });

  it('fast prompt states the exact safe-area pixel lines', () => {
    const p = buildFastPrompt(req, plan, []);
    expect(p).toContain('x=54');
    expect(p).toContain('x=1026');
    expect(p).toContain('y=269');
    expect(p).toContain('y=1536');
  });

  it('plate prompt bans all foreground content and keeps the style', () => {
    const p = buildPlatePrompt(req, plan, []);
    expect(p).toMatch(/NO product.*NO logo.*NO text/s);
    expect(p).toContain('teal gradient');
  });

  it('retry notes are appended to both prompts', () => {
    expect(buildFastPrompt(req, plan, ['fix the headline']).toLowerCase()).toContain('fix the headline');
    expect(buildPlatePrompt(req, plan, ['no letters']).toLowerCase()).toContain('no letters');
  });

  it('qa prompt compares output against the source image, not just the facts', () => {
    const p = buildQaPrompt(source.analysis, 1080, 1080, [], { x: 43, y: 43, w: 994, h: 994 });
    expect(p).toContain('FIRST is the SOURCE');
    expect(p).toContain('NEITHER in the source image NOR');
    expect(p).toContain('20% הנחה');
  });

  it('qa prompt states the exact safe-area pixel lines (no eyeballed percents)', () => {
    const p = buildQaPrompt(source.analysis, 1200, 627, [], { x: 48, y: 25, w: 1104, h: 577 });
    expect(p).toContain('x=48');
    expect(p).toContain('x=1152');
    expect(p).toContain('y=25');
    expect(p).toContain('y=602');
  });
});
