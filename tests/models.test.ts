import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { adClaimsSchema } from '../src/shared/schemas.js';
import {
  boxIoU,
  convertBoxToPixels,
  countMaskInRect,
  detectCoordinateSystem,
  dilateMask,
  maskArea,
  maskBoundingBox,
  placeRasterInFrame,
  unionMasks,
} from '../src/shared/geometry.js';
import { extractJsonObject } from '../src/server/models/extract-ad.js';
import { buildBoxPromptText, reportedFrameSizes } from '../src/server/models/sam.js';
import { isTransientModelError, normalizeUsage, withModelRetry } from '../src/server/models/client.js';

// Fictional offer text for tests only — no real brands, IDs or secrets.
const VALID_CLAIMS = {
  language: 'en',
  offer_texts: [{ text: '50% sale on everything today', bbox: { x: 10, y: 20, w: 100, h: 30 }, in_panel: true }],
  discount: { percent: 50, scope: 'all', verbatim: '50% sale' },
  shipping: { terms: 'unspecified', verbatim: '' },
  valid_until: { day_month: null, verbatim: '' },
  panel: { bbox: { x: 0, y: 0, w: 200, h: 100 }, opaque: true },
  product_bbox: null,
  logo_bbox: { x: 1, y: 2, w: 3, h: 4 },
  unreadable: ['tiny print at the bottom edge'],
};

describe('adClaimsSchema', () => {
  it('parses a complete valid object', () => {
    const claims = adClaimsSchema.parse(VALID_CLAIMS);
    expect(claims.discount.percent).toBe(50);
    expect(claims.panel?.opaque).toBe(true);
    expect(claims.product_bbox).toBeNull();
  });

  it('strips confidence fields instead of keeping them (decision 6: no self-reported scores)', () => {
    const withConfidence = {
      ...VALID_CLAIMS,
      confidence: 0.9,
      discount: { ...VALID_CLAIMS.discount, confidence: 0.8 },
      offer_texts: [{ ...VALID_CLAIMS.offer_texts[0], confidence: 0.7 }],
    };
    const claims = adClaimsSchema.parse(withConfidence);
    expect(claims).not.toHaveProperty('confidence');
    expect(claims.discount).not.toHaveProperty('confidence');
    expect(claims.offer_texts[0]).not.toHaveProperty('confidence');
  });

  it('rejects an invalid scope', () => {
    expect(() =>
      adClaimsSchema.parse({ ...VALID_CLAIMS, discount: { ...VALID_CLAIMS.discount, scope: 'everything' } }),
    ).toThrow();
  });

  it('rejects a malformed day_month', () => {
    expect(() =>
      adClaimsSchema.parse({ ...VALID_CLAIMS, valid_until: { day_month: '10-11', verbatim: 'x' } }),
    ).toThrow(/DD\.MM/);
    expect(adClaimsSchema.parse({ ...VALID_CLAIMS, valid_until: { day_month: '10.11', verbatim: 'x' } }).valid_until.day_month).toBe(
      '10.11',
    );
  });

  it('rejects non-numeric and non-finite percents', () => {
    expect(() =>
      adClaimsSchema.parse({ ...VALID_CLAIMS, discount: { ...VALID_CLAIMS.discount, percent: 'fifty' } }),
    ).toThrow();
    expect(() =>
      adClaimsSchema.parse({ ...VALID_CLAIMS, discount: { ...VALID_CLAIMS.discount, percent: Number.NaN } }),
    ).toThrow();
  });

  it('rejects a missing required section', () => {
    const { discount: _d, ...rest } = VALID_CLAIMS;
    expect(() => adClaimsSchema.parse(rest)).toThrow();
  });

  it('accepts null panel / product / logo and empty lists', () => {
    const claims = adClaimsSchema.parse({ ...VALID_CLAIMS, offer_texts: [], panel: null, logo_bbox: null, unreadable: [] });
    expect(claims.offer_texts).toEqual([]);
    expect(claims.panel).toBeNull();
  });
});

describe('boxIoU', () => {
  it('is 1 for identical boxes', () => {
    expect(boxIoU({ x: 90, y: 840, w: 900, h: 170 }, { x: 90, y: 840, w: 900, h: 170 })).toBe(1);
  });

  it('is 0 for disjoint boxes', () => {
    expect(boxIoU({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(0);
  });

  it('computes the partial-overlap ratio', () => {
    // inter 5x5=25, union 100+100-25=175
    expect(boxIoU({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBeCloseTo(25 / 175, 10);
  });

  it('is 0 when either box is empty', () => {
    expect(boxIoU({ x: 0, y: 0, w: 0, h: 5 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(0);
    expect(boxIoU({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 0 })).toBe(0);
  });
});

describe('detectCoordinateSystem', () => {
  it('defaults empty input to pixels', () => {
    expect(detectCoordinateSystem([])).toBe('pixels');
  });

  it('detects pixels when any value exceeds 1000', () => {
    expect(detectCoordinateSystem([{ x: 0, y: 900, w: 1080, h: 180 }])).toBe('pixels');
  });

  it('defaults ambiguous all-under-1000 integers to pixels (the prompted system)', () => {
    expect(detectCoordinateSystem([{ x: 90, y: 840, w: 900, h: 170 }])).toBe('pixels');
  });

  it('detects 0-1 unit scale', () => {
    expect(detectCoordinateSystem([{ x: 0.08, y: 0.78, w: 0.83, h: 0.16 }])).toBe('unit');
  });

  it('detects 0-1000 scale from fractional values', () => {
    expect(detectCoordinateSystem([{ x: 83.3, y: 777.8, w: 833.3, h: 157.4 }])).toBe('1000');
  });
});

describe('convertBoxToPixels', () => {
  it('rounds pixel boxes', () => {
    expect(convertBoxToPixels({ x: 1.6, y: 2.4, w: 3.4, h: 4.4 }, 'pixels', 1080, 1080)).toEqual({
      x: 2,
      y: 2,
      w: 3,
      h: 4,
    });
  });

  it('scales unit boxes by the frame size', () => {
    expect(convertBoxToPixels({ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, 'unit', 1000, 2000)).toEqual({
      x: 500,
      y: 500,
      w: 100,
      h: 400,
    });
  });

  it('scales 0-1000 boxes by frame/1000', () => {
    expect(convertBoxToPixels({ x: 83.3, y: 777.8, w: 833.3, h: 157.4 }, '1000', 1080, 1080)).toEqual({
      x: 90,
      y: 840,
      w: 900,
      h: 170,
    });
  });
});

describe('placeRasterInFrame', () => {
  it('places an HxW raster at the top-left of its bounds', () => {
    // raster 2 wide x 3 tall: [1,0] / [1,1] / [0,1]
    const raster = Uint8Array.from([1, 0, 1, 1, 0, 1]);
    const frame = placeRasterInFrame(raster, 2, 3, { left: 1, top: 1, right: 3, bottom: 4 }, 5, 4);
    expect(maskArea(frame)).toBe(4);
    const at = (x: number, y: number) => frame[y * 5 + x];
    expect(at(1, 1)).toBe(1);
    expect(at(2, 1)).toBe(0);
    expect(at(1, 2)).toBe(1);
    expect(at(2, 2)).toBe(1);
    expect(at(1, 3)).toBe(0);
    expect(at(2, 3)).toBe(1);
    expect(at(0, 0)).toBe(0);
    expect(at(4, 3)).toBe(0);
  });

  it('clips a raster that hangs outside the frame', () => {
    const raster = Uint8Array.from({ length: 9 }, () => 1);
    const frame = placeRasterInFrame(raster, 3, 3, { left: -1, top: -1, right: 2, bottom: 2 }, 5, 5);
    expect(maskArea(frame)).toBe(4);
    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(1);
    expect(frame[5]).toBe(1);
    expect(frame[6]).toBe(1);
    expect(frame[2]).toBe(0);
  });
});

describe('unionMasks / dilateMask', () => {
  it('unions two masks pixel-wise', () => {
    expect(unionMasks(Uint8Array.from([1, 0, 0, 1]), Uint8Array.from([0, 1, 0, 1]))).toEqual(
      Uint8Array.from([1, 1, 0, 1]),
    );
  });

  it('rejects size mismatches', () => {
    expect(() => unionMasks(new Uint8Array(4), new Uint8Array(5))).toThrow(/mismatch/);
  });

  it('dilates a single pixel to a 3x3 block with radius 1', () => {
    const mask = new Uint8Array(25);
    mask[2 * 5 + 2] = 1;
    const out = dilateMask(mask, 5, 5, 1);
    expect(maskArea(out)).toBe(9);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) expect(out[y * 5 + x]).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('clips dilation at the frame edge', () => {
    const mask = new Uint8Array(9);
    mask[0] = 1;
    expect(maskArea(dilateMask(mask, 3, 3, 1))).toBe(4);
  });

  it('returns an equal mask for radius 0', () => {
    const mask = Uint8Array.from([1, 0, 1]);
    expect(dilateMask(mask, 3, 1, 0)).toEqual(mask);
  });
});

describe('countMaskInRect', () => {
  // 4x4: full first row + one pixel at (0,1)
  const mask = Uint8Array.from([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  it('counts set pixels inside the rect', () => {
    expect(countMaskInRect(mask, 4, 4, { x: 0, y: 0, w: 4, h: 1 })).toBe(4);
    expect(countMaskInRect(mask, 4, 4, { x: 0, y: 0, w: 2, h: 2 })).toBe(3);
  });

  it('returns 0 for an empty intersection', () => {
    expect(countMaskInRect(mask, 4, 4, { x: 0, y: 2, w: 4, h: 2 })).toBe(0);
  });

  it('clips rects that hang outside the frame', () => {
    expect(countMaskInRect(mask, 4, 4, { x: 2, y: 0, w: 4, h: 4 })).toBe(2);
  });
});

describe('maskBoundingBox', () => {
  it('returns null for an empty mask', () => {
    expect(maskBoundingBox(new Uint8Array(9), 3, 3)).toBeNull();
  });

  it('returns the tight half-open box', () => {
    const mask = new Uint8Array(9);
    mask[0 * 3 + 1] = 1;
    mask[2 * 3 + 2] = 1;
    expect(maskBoundingBox(mask, 3, 3)).toEqual({ x: 1, y: 0, w: 2, h: 3 });
  });
});

describe('extractJsonObject', () => {
  it('parses pure JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps code fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('finds the object inside prose', () => {
    expect(extractJsonObject('Here it is: {"a":1} done.')).toEqual({ a: 1 });
  });

  it('throws when there is no object', () => {
    expect(() => extractJsonObject('no json here')).toThrow(/No JSON object/);
  });
});

describe('buildBoxPromptText', () => {
  it('encodes a half-open box (inclusive x2/y2 on the wire)', () => {
    expect(buildBoxPromptText({ x: 10, y: 20, w: 30, h: 40 }, 640, 480)).toBe(
      '<0f>1<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|>',
    );
  });

  it('clamps an overflowing box into the frame', () => {
    expect(buildBoxPromptText({ x: 630, y: 470, w: 50, h: 50 }, 640, 480)).toBe(
      '<0f>1<|box;x1=630;y1=470;x2=639;y2=479;w=640;h=480|>',
    );
  });

  it('throws for an empty box', () => {
    expect(() => buildBoxPromptText({ x: 5, y: 5, w: 0, h: 10 }, 640, 480)).toThrow(/empty box/);
  });
});

describe('reportedFrameSizes', () => {
  it('collects unique w/h pairs from wire text', () => {
    const raw = '<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=1080;h=1080|>,1<|box;x1=5;y1=6;x2=7;y2=8;w=1080;h=1080|>';
    expect(reportedFrameSizes(raw)).toEqual([{ w: 1080, h: 1080 }]);
  });

  it('returns an empty list when nothing was reported', () => {
    expect(reportedFrameSizes('')).toEqual([]);
  });
});

describe('normalizeUsage', () => {
  it('reads chat-style usage', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('reads responses-style usage and totals it', () => {
    expect(normalizeUsage({ input_tokens: 7, output_tokens: 3 })).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
  });

  it('returns undefined for garbage', () => {
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage({})).toBeUndefined();
  });
});

describe('model retry policy', () => {
  it('retries 429/5xx but never 4xx', () => {
    expect(isTransientModelError(new OpenAI.APIError(429, {}, 'slow down', undefined))).toBe(true);
    expect(isTransientModelError(new OpenAI.APIError(500, {}, 'boom', undefined))).toBe(true);
    expect(isTransientModelError(new OpenAI.APIError(400, {}, 'bad request', undefined))).toBe(false);
    expect(isTransientModelError(new OpenAI.APIError(401, {}, 'unauthorized', undefined))).toBe(false);
    expect(isTransientModelError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientModelError(new Error('plain'))).toBe(false);
  });

  it('retries a transient failure once and then succeeds', async () => {
    let calls = 0;
    const result = await withModelRetry(async () => {
      calls++;
      if (calls === 1) throw new OpenAI.APIError(500, {}, 'boom', undefined);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  }, 15000);

  it('does not retry a 400', async () => {
    let calls = 0;
    await expect(
      withModelRetry(async () => {
        calls++;
        throw new OpenAI.APIError(400, {}, 'bad request', undefined);
      }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
});
