import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { presetById } from '../src/shared/presets.js';
import type { SourceAnalysis } from '../src/shared/schemas.js';
import { CostLedger } from '../src/server/models/costs.js';
import {
  buildWonderPlanPrompt,
  buildWonderReviewPrompt,
  checkTextWithSpark,
  planWithWonder,
  reviewWithWonder,
  wonderPatchSchema,
  wonderPlanSchema,
  wonderReviewSchema,
} from '../src/server/models/wonder.js';
import { checkManifestGeometry, checksPass } from '../src/server/adfit/checks.js';
import { manifestFromPlan } from '../src/server/adfit/manifest.js';
import type { LayoutPlan } from '../src/shared/schemas.js';

function analysis(): SourceAnalysis {
  return {
    language: 'he',
    direction: 'rtl',
    products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 390, y: 210, w: 300, h: 560 } }],
    logo_bbox: { x: 850, y: 56, w: 170, h: 84 },
    headline: { text: '20% הנחה', bbox: { x: 90, y: 840, w: 900, h: 100 }, bold: true, color: '#ffffff' },
    subtext: null,
    panel: { bbox: { x: 90, y: 820, w: 900, h: 170 }, opaque: true, bg_color: '#ff5a3c', text_color: '#ffffff', texts: ['20% הנחה'] },
    other_texts: [],
    background: { type: 'gradient', description: 'teal gradient', colors: ['#e9f5f3'] },
    unreadable: [],
  };
}

function mockClient(reply: unknown, usage: unknown = { input_tokens: 100, output_tokens: 50, total_tokens: 150 }): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }], usage }),
      },
    },
  } as unknown as OpenAI;
}

describe('wonder plan', () => {
  const sizes = [{ preset: presetById('fb-link')!, template: null }];

  it('prompt carries elements, text, families, rules and safe areas', () => {
    const p = buildWonderPlanPrompt({
      sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', sourceWidth: 1080, sourceHeight: 1080,
      analysis: analysis(),
      elementBoxes: [{ id: 'product-0', w: 300, h: 560 }],
      measuredText: { headline: { width: 400, height: 60, fontPx: 60 } },
      sizes,
    });
    expect(p).toContain('landscape_split');
    expect(p).toContain('portrait_stack');
    expect(p).toContain('square_balanced');
    expect(p).toContain('20% הנחה');
    expect(p).toContain('6%');
    expect(p).toContain('fb-link 1200x628');
  });

  it('parses a structured plan and logs the ledger cost', async () => {
    const ledger = new CostLedger(25);
    const res = await planWithWonder(mockClient({ sizes: [{ preset: 'fb-link', family: 'landscape_split', boxes: { products: [{ x: 0, y: 0, w: 0.4, h: 1 }], logo: null, panel: null, headline: null, subtext: null, others: [] }, align: 'right', background_brief: 'mint, clean right side', rationale: 'product left, text right' }] }), {
      model: 'muse-wonder-1.0',
      sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', sourceWidth: 1080, sourceHeight: 1080,
      analysis: analysis(), elementBoxes: [], measuredText: {}, sizes, ledger,
    });
    expect(res.ok).toBe(true);
    expect(wonderPlanSchema.parse(res.parsed).sizes[0]?.family).toBe('landscape_split');
    expect(ledger.totals().wonderUsd).toBeGreaterThan(0);
  });

  it('falls back without calling when the session ledger passes $25', async () => {
    const ledger = new CostLedger(25);
    ledger.record('muse-wonder-1.0', { inputTokens: 1_000_000, outputTokens: 2_000_000 }, 'prior');
    let calls = 0;
    const counting = { chat: { completions: { create: async () => { calls++; throw new Error('must not call'); } } } } as unknown as OpenAI;
    const res = await planWithWonder(counting, {
      model: 'muse-wonder-1.0',
      sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', sourceWidth: 1080, sourceHeight: 1080,
      analysis: analysis(), elementBoxes: [], measuredText: {}, sizes, ledger,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/budget cap/);
    expect(calls).toBe(0);
  });

  it('falls back on model errors', async () => {
    const failing = { chat: { completions: { create: async () => { throw new OpenAI.APIError(400, { error: { message: 'bad' } } as never, 'bad', new Headers()); } } } } as unknown as OpenAI;
    const res = await planWithWonder(failing, {
      model: 'muse-wonder-1.0',
      sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', sourceWidth: 1080, sourceHeight: 1080,
      analysis: analysis(), elementBoxes: [], measuredText: {}, sizes,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/code planner/);
  });
});

describe('wonder review', () => {
  it('prompt includes deterministic findings and the patch contract', () => {
    const p = buildWonderReviewPrompt({
      sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', analysis: analysis(),
      outputs: [{ preset: 'fb-link', imageBytes: Buffer.alloc(8), mimeType: 'image/png', manifestJson: '{"preset":"fb-link"}', checks: [{ code: 'overlap', severity: 'fail', element: 'logo', detail: 'logo overlaps panel' }] }],
    });
    expect(p).toContain('overlap');
    expect(p).toContain('regenerate_plate');
    expect(p).toContain('fb-link');
  });

  it('parses element-level patches', async () => {
    const res = await reviewWithWonder(
      mockClient({ defects: [{ size: 'fb-link', element: 'logo', group: null, action: 'scale', by: 1.3, reason: 'logo too small' }] }),
      {
        model: 'muse-wonder-1.0', sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', analysis: analysis(),
        outputs: [{ preset: 'fb-link', imageBytes: Buffer.alloc(8), mimeType: 'image/png', manifestJson: '{}', checks: [] }],
      },
    );
    expect(res.ok).toBe(true);
    const patch = wonderReviewSchema.parse(res.parsed).defects[0]!;
    expect(wonderPatchSchema.parse(patch).by).toBe(1.3);
  });

  it('batched spark text check covers every size in one call', async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            return { choices: [{ message: { content: JSON.stringify({ sizes: [{ preset: 'fb-link', all_exact: true, wrong: [] }] }) } }], usage: {} };
          },
        },
      },
    } as unknown as OpenAI;
    const res = await checkTextWithSpark(client, {
      model: 'muse-spark-1.3',
      outputs: [{ preset: 'fb-link', imageBytes: Buffer.alloc(8), mimeType: 'image/png', expected: ['20% הנחה'] }],
    });
    expect(res.ok).toBe(true);
    expect(res.parsed?.sizes).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe('deterministic checks', () => {
  function goodPlan(): LayoutPlan {
    return {
      preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
      safe: { x: 43, y: 43, w: 994, h: 994 },
      logo: { x: 820, y: 70, w: 170, h: 60 },
      products: [{ x: 340, y: 200, w: 400, h: 500 }],
      headline: { x: 240, y: 740, w: 600, h: 60 },
      subtext: null, panel: null, other_texts: [],
      product_scales: [1], logo_scale: 1, notes: [],
    };
  }

  it('passes a clean manifest', () => {
    const m = manifestFromPlan({ plan: goodPlan(), preset: presetById('ig-feed-11')!, planner: 'code', direction: 'rtl' });
    // Drop the panel-traveling headline requirement: analysis has a panel, so
    // headline placement is optional — use a panel-free analysis here.
    const a = analysis();
    a.panel = null;
    const findings = checkManifestGeometry(m, a, { headline: [60] });
    expect(checksPass(findings)).toBe(true);
  });

  it('fails safe-area escapes, overlaps, tiny text and missing products', () => {
    const m = manifestFromPlan({
      plan: { ...goodPlan(), logo: { x: 1000, y: 10, w: 200, h: 60 }, products: [{ x: 1000, y: 10, w: 200, h: 200 }], product_scales: [1] },
      preset: presetById('ig-feed-11')!, planner: 'code', direction: 'rtl',
    });
    const findings = checkManifestGeometry(m, analysis(), { headline: [10] });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('safe_area');
    expect(codes).toContain('overlap');
    expect(codes).toContain('text_size');
    expect(checksPass(findings)).toBe(false);
  });
});
