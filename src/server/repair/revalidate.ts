import type { AdClaims } from '../../shared/schemas.js';
import { compareClaims, type OfferSpec } from './spec.js';

export interface RevalidationCheck {
  check: string;
  pass: boolean;
  detail: string;
}

export interface Revalidation {
  pass: boolean;
  checks: RevalidationCheck[];
  /** Normalized fields of the fresh Spark extraction (set by the caller). */
  claims?: {
    percent: number | null;
    scope: string;
    shipping: string;
    valid: string | null;
  };
}

const SCOPE_WORDS: Record<string, string[]> = {
  all: ['הכל', 'everything'],
  selected_models: ['נבחרים', 'selected'],
};

const SHIPPING_WORDS: Record<string, string[]> = {
  free: ['חינם', 'free'],
  paid: ['בתשלום', 'paid'],
};

function includesWord(haystack: string, word: string): boolean {
  return haystack.toLowerCase().includes(word.toLowerCase());
}

/** Bare-number match with non-digit boundaries, so "2" never matches "20". */
function includesNumber(haystack: string, n: number): boolean {
  return haystack.includes(`${n}%`) || new RegExp(`(^|\\D)${n}(\\D|$)`).test(haystack);
}

/**
 * Revalidation of the repaired image (fresh Spark extraction on after.png).
 * Passes only when the repaired claims match the spec, no old promise
 * remains anywhere in offer_texts, no new unsupported promise appears, and
 * the offer language is unchanged.
 */
export function revalidate(
  before: AdClaims,
  after: AdClaims,
  spec: OfferSpec,
): Revalidation {
  const checks: RevalidationCheck[] = [];

  for (const c of compareClaims(spec, after)) {
    checks.push({
      check: c.field,
      pass: c.match,
      detail: c.match ? `matches spec (${c.want})` : `got ${c.got}, want ${c.want}`,
    });
  }

  const joined = after.offer_texts.map((t) => t.text).join('\n');

  // No old promise remains: for every field the repair changed, the old
  // value's tokens must be gone from ALL offer texts (both languages).
  if (before.discount.percent !== null && before.discount.percent !== spec.percent) {
    const gone = !includesNumber(joined, before.discount.percent);
    checks.push({
      check: 'old_percent_gone',
      pass: gone,
      detail: gone
        ? `old ${before.discount.percent}% absent`
        : `old ${before.discount.percent}% still present in: ${JSON.stringify(joined)}`,
    });
  }
  if (before.discount.scope !== 'unspecified' && before.discount.scope !== spec.scope) {
    const words = SCOPE_WORDS[before.discount.scope] ?? [];
    const found = words.filter((w) => includesWord(joined, w));
    checks.push({
      check: 'old_scope_gone',
      pass: found.length === 0,
      detail: found.length === 0 ? 'old scope words absent' : `old scope words present: ${found.join(', ')}`,
    });
  }
  if (before.shipping.terms !== 'unspecified' && before.shipping.terms !== spec.shipping) {
    const words = SHIPPING_WORDS[before.shipping.terms] ?? [];
    const found = words.filter((w) => includesWord(joined, w));
    checks.push({
      check: 'old_shipping_gone',
      pass: found.length === 0,
      detail: found.length === 0 ? 'old shipping words absent' : `old shipping words present: ${found.join(', ')}`,
    });
  }
  if (
    before.valid_until.day_month !== null &&
    before.valid_until.day_month !== spec.dayMonth &&
    spec.dayMonth !== null
  ) {
    const gone = !joined.includes(before.valid_until.day_month);
    checks.push({
      check: 'old_date_gone',
      pass: gone,
      detail: gone ? `old ${before.valid_until.day_month} absent` : `old date still present`,
    });
  }

  // No new unsupported promise: any percent/date printed anywhere must equal
  // the spec (the field checks above cover the normalized values).
  if (spec.percent !== null) {
    const bad: number[] = [];
    for (const m of joined.matchAll(/(\d+)\s*%/g)) {
      const n = Number(m[1]);
      if (n !== spec.percent && !bad.includes(n)) bad.push(n);
    }
    checks.push({
      check: 'no_new_percent',
      pass: bad.length === 0,
      detail: bad.length === 0 ? 'no foreign percent printed' : `unsupported percent(s): ${bad.join(', ')}`,
    });
  }
  if (spec.dayMonth !== null) {
    const bad: string[] = [];
    for (const m of joined.matchAll(/(\d{1,2})\.(\d{1,2})/g)) {
      const d = `${m[1]?.padStart(2, '0')}.${m[2]?.padStart(2, '0')}`;
      if (d !== spec.dayMonth && !bad.includes(d)) bad.push(d);
    }
    checks.push({
      check: 'no_new_date',
      pass: bad.length === 0,
      detail: bad.length === 0 ? 'no foreign date printed' : `unsupported date(s): ${bad.join(', ')}`,
    });
  }

  const langOk = after.language === before.language;
  checks.push({
    check: 'language_unchanged',
    pass: langOk,
    detail: langOk ? `still ${after.language}` : `was ${before.language}, now ${after.language}`,
  });

  return { pass: checks.every((c) => c.pass), checks };
}
