import { z } from 'zod';
import type { AdClaims } from '../../shared/schemas.js';

const offerSpecFileSchema = z.object({
  version: z.number(),
  discount: z.object({ percent: z.number(), scope: z.string() }),
  shipping: z.string(),
  valid_until: z.string(),
  timezone: z.string().optional(),
  required_disclosures: z.array(z.string()).optional(),
});

export interface OfferSpec {
  version: number;
  percent: number | null;
  scope: 'all' | 'selected_models' | 'unspecified';
  shipping: 'free' | 'paid' | 'unspecified';
  /** Expiry as DD.MM for template + comparison use. */
  dayMonth: string | null;
}

function asScope(v: string): OfferSpec['scope'] {
  return v === 'all' || v === 'selected_models' || v === 'unspecified' ? v : 'unspecified';
}

function asShipping(v: string): OfferSpec['shipping'] {
  return v === 'free' || v === 'paid' || v === 'unspecified' ? v : 'unspecified';
}

/** "2026-11-10" (or "10.11") → "10.11". */
export function toDayMonth(isoOrShort: string): string | null {
  const iso = isoOrShort.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}`;
  const short = isoOrShort.match(/^(\d{2})\.(\d{2})$/);
  return short ? isoOrShort : null;
}

export function loadOfferSpec(json: unknown): OfferSpec {
  const f = offerSpecFileSchema.parse(json);
  return {
    version: f.version,
    percent: Number.isFinite(f.discount.percent) ? f.discount.percent : null,
    scope: asScope(f.discount.scope),
    shipping: asShipping(f.shipping),
    dayMonth: toDayMonth(f.valid_until),
  };
}

export interface FieldComparison {
  field: 'percent' | 'scope' | 'shipping' | 'valid_until';
  match: boolean;
  got: string;
  want: string;
}

const fmt = (v: unknown): string => (v === null || v === undefined ? '(none)' : String(v));

/** Deterministic field-by-field comparison of extracted claims vs the spec. */
export function compareClaims(spec: OfferSpec, claims: AdClaims): FieldComparison[] {
  return [
    {
      field: 'percent',
      match: claims.discount.percent === spec.percent,
      got: fmt(claims.discount.percent),
      want: fmt(spec.percent),
    },
    {
      field: 'scope',
      match: claims.discount.scope === spec.scope,
      got: claims.discount.scope,
      want: spec.scope,
    },
    {
      field: 'shipping',
      match: claims.shipping.terms === spec.shipping,
      got: claims.shipping.terms,
      want: spec.shipping,
    },
    {
      field: 'valid_until',
      match: claims.valid_until.day_month === spec.dayMonth,
      got: fmt(claims.valid_until.day_month),
      want: fmt(spec.dayMonth),
    },
  ];
}

export function isClean(comparisons: FieldComparison[]): boolean {
  return comparisons.every((c) => c.match);
}

export interface OutsidePanelContradiction {
  text: string;
  reason: string;
}

function normDate(m: RegExpMatchArray): string {
  return `${m[1]?.padStart(2, '0')}.${m[2]?.padStart(2, '0')}`;
}

/**
 * Repair gate: any offer text OUTSIDE the panel that contradicts the spec
 * refuses the repair (`wrong_text_outside_panel`) — repainting the panel
 * cannot fix a wrong promise printed elsewhere. Texts outside the panel
 * that agree with the spec are fine. Patterns cover Hebrew + English.
 */
export function findOutsidePanelContradiction(
  spec: OfferSpec,
  claims: AdClaims,
): OutsidePanelContradiction | null {
  for (const t of claims.offer_texts) {
    if (t.in_panel) continue;
    const text = t.text;
    for (const m of text.matchAll(/(\d+)\s*%/g)) {
      const n = Number(m[1]);
      if (spec.percent !== null && n !== spec.percent) {
        return { text, reason: `percent ${n}% outside the panel, spec is ${spec.percent}%` };
      }
    }
    if (spec.shipping !== 'free' && /חינם|free/i.test(text)) {
      return { text, reason: 'free shipping promised outside the panel, spec shipping is paid' };
    }
    if (spec.shipping !== 'paid' && /בתשלום|paid/i.test(text)) {
      return { text, reason: 'paid shipping stated outside the panel, spec shipping is free' };
    }
    if (spec.scope !== 'all' && /הכל|everything/i.test(text)) {
      return { text, reason: '"everything" scope outside the panel, spec is limited to some products' };
    }
    if (spec.scope !== 'selected_models' && /נבחרים|selected/i.test(text)) {
      return { text, reason: '"selected" scope outside the panel, spec covers everything' };
    }
    for (const m of text.matchAll(/(\d{1,2})\.(\d{1,2})/g)) {
      const d = normDate(m);
      if (spec.dayMonth !== null && d !== spec.dayMonth) {
        return { text, reason: `date ${d} outside the panel, spec is ${spec.dayMonth}` };
      }
    }
  }
  return null;
}
