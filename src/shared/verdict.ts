import type { AdClaims, PageClaims } from './schemas.js';
import { t, type Lang, type MessageKey } from './i18n.js';

/**
 * Comparison + verdict rules (ARCHITECTURE.md section 5). Pure code, no model.
 *
 * Field by field, each side (ad, page) is agree / contradict / unknown
 * against the spec. "Unspecified" is unknown — never "none", never agreement.
 */

export type Verdict =
  | 'CLEAN'
  | 'AD_WRONG_REPAIRABLE'
  | 'AD_WRONG_UNSAFE'
  | 'PAGE_WRONG'
  | 'AMBIGUOUS'
  | 'CAPTURE_FAILED'
  | 'UNSUPPORTED_FORMAT';

export type VerdictField = 'percent' | 'scope' | 'shipping' | 'valid_until';
export type VerdictSide = 'ad' | 'page';
export type FieldStatus = 'agree' | 'contradict' | 'unknown';

/** Minimal spec view (OfferSpec satisfies this structurally). */
export interface VerdictSpec {
  percent: number | null;
  scope: 'all' | 'selected_models' | 'unspecified';
  shipping: 'free' | 'paid' | 'unspecified';
  dayMonth: string | null;
}

export interface FieldComparison {
  field: VerdictField;
  ad: FieldStatus;
  page: FieldStatus;
  spec: string;
  adObserved: string;
  pageObserved: string;
}

export type FindingKind = 'contradiction' | 'missing' | 'page_wrong' | 'repair_blocker';

export interface Finding {
  id: string;
  kind: FindingKind;
  side: VerdictSide | null;
  field: VerdictField | null;
  specValue: string | null;
  observedValue: string | null;
  evidenceIds: string[];
  /** Rendered in the sweep language; messageKey+vars allow re-rendering. */
  detail: string;
  messageKey: MessageKey | null;
  vars: Record<string, string>;
}

export interface VerdictInput {
  spec: VerdictSpec;
  ad: AdClaims;
  /** Null only when the capture failed (then captureFailed must be true). */
  page: PageClaims | null;
  captureFailed: boolean;
  /** Repair blockers known at verdict time (cheap gates; the repair run may add more). */
  repairBlockers: string[];
  lang: Lang;
}

export interface VerdictOutput {
  verdict: Verdict;
  comparisons: FieldComparison[];
  findings: Finding[];
  /** The one focused question for AMBIGUOUS, else null. */
  question: string | null;
}

export const VERDICT_MESSAGE_KEY: Record<Verdict, MessageKey> = {
  CLEAN: 'verdict_clean',
  AD_WRONG_REPAIRABLE: 'verdict_ad_wrong_repairable',
  AD_WRONG_UNSAFE: 'verdict_ad_wrong_unsafe',
  PAGE_WRONG: 'verdict_page_wrong',
  AMBIGUOUS: 'verdict_ambiguous',
  CAPTURE_FAILED: 'verdict_capture_failed',
  UNSUPPORTED_FORMAT: 'verdict_unsupported_format',
};

export function verdictText(lang: Lang, verdict: Verdict): string {
  return t(lang, VERDICT_MESSAGE_KEY[verdict]);
}

const FIELD_KEY: Record<VerdictField, MessageKey> = {
  percent: 'field_percent',
  scope: 'field_scope',
  shipping: 'field_shipping',
  valid_until: 'field_valid_until',
};

const SIDE_KEY: Record<VerdictSide, MessageKey> = {
  ad: 'side_ad',
  page: 'side_page',
};

const SPEC_EVIDENCE_ID: Record<VerdictField, string> = {
  percent: 'spec:discount.percent',
  scope: 'spec:discount.scope',
  shipping: 'spec:shipping',
  valid_until: 'spec:valid_until',
};

interface SideValues {
  percent: number | null;
  scope: 'all' | 'selected_models' | 'unspecified';
  shipping: 'free' | 'paid' | 'unspecified';
  dayMonth: string | null;
}

function adValues(ad: AdClaims): SideValues {
  return {
    percent: ad.discount.percent,
    scope: ad.discount.scope,
    shipping: ad.shipping.terms,
    dayMonth: ad.valid_until.day_month,
  };
}

function pageValues(page: PageClaims): SideValues {
  return {
    percent: page.discount.percent,
    scope: page.discount.scope,
    shipping: page.shipping.terms,
    dayMonth: page.valid_until.day_month,
  };
}

function statusOf(got: string | number | null, want: string | number | null, unknown: string | number | null): FieldStatus {
  if (got === unknown) return 'unknown';
  return got === want ? 'agree' : 'contradict';
}

const fmtVal = (v: string | number | null): string => (v === null ? '(none stated)' : String(v));

function compareSide(spec: VerdictSpec, v: SideValues): Record<VerdictField, FieldStatus> {
  return {
    percent: statusOf(v.percent, spec.percent, null),
    scope: statusOf(v.scope, spec.scope, 'unspecified'),
    shipping: statusOf(v.shipping, spec.shipping, 'unspecified'),
    valid_until: statusOf(v.dayMonth, spec.dayMonth, null),
  };
}

const FIELD_TOKEN_TEST: Record<VerdictField, RegExp> = {
  percent: /\d+\s*%/,
  scope: /הכל|נבחרים|everything|selected/i,
  shipping: /חינם|בתשלום|לא כלול|free|paid|not included/i,
  valid_until: /\d{1,2}\.\d{1,2}/,
};

const AD_FIELD_EVIDENCE_ID: Record<VerdictField, string> = {
  percent: 'ad:discount',
  scope: 'ad:discount',
  shipping: 'ad:shipping',
  valid_until: 'ad:valid_until',
};

const PAGE_FIELD_EVIDENCE_ID: Record<VerdictField, string> = {
  percent: 'page:discount',
  scope: 'page:discount',
  shipping: 'page:shipping',
  valid_until: 'page:valid_until',
};

/** Evidence ids for one ad-side field: normalized claim + matching offer texts (crop refs). */
export function evidenceForAd(ad: AdClaims, field: VerdictField): string[] {
  const ids = [AD_FIELD_EVIDENCE_ID[field]];
  const test = FIELD_TOKEN_TEST[field];
  ad.offer_texts.forEach((o, i) => {
    if (test.test(o.text)) ids.push(`ad:offer_text:${i}`);
  });
  return ids;
}

/** Evidence ids for one page-side field: normalized claim + matching quotes/chunks. */
export function evidenceForPage(page: PageClaims, field: VerdictField): string[] {
  const ids = [PAGE_FIELD_EVIDENCE_ID[field]];
  const test = FIELD_TOKEN_TEST[field];
  page.quotes.forEach((q, i) => {
    if (test.test(q.text)) {
      ids.push(`page:quote:${i}`);
      for (const c of q.chunk_ids) ids.push(`page:chunk:${c}`);
    }
  });
  return ids;
}

export function buildComparisons(spec: VerdictSpec, ad: AdClaims, page: PageClaims): FieldComparison[] {
  const a = compareSide(spec, adValues(ad));
  const p = compareSide(spec, pageValues(page));
  const av = adValues(ad);
  const pv = pageValues(page);
  const fields: VerdictField[] = ['percent', 'scope', 'shipping', 'valid_until'];
  return fields.map((field) => ({
    field,
    ad: a[field] as FieldStatus,
    page: p[field] as FieldStatus,
    spec:
      field === 'percent'
        ? fmtVal(spec.percent === null ? null : `${spec.percent}%`)
        : field === 'scope'
          ? spec.scope
          : field === 'shipping'
            ? spec.shipping
            : fmtVal(spec.dayMonth),
    adObserved:
      field === 'percent'
        ? fmtVal(av.percent === null ? null : `${av.percent}%`)
        : field === 'scope'
          ? av.scope
          : field === 'shipping'
            ? av.shipping
            : fmtVal(av.dayMonth),
    pageObserved:
      field === 'percent'
        ? fmtVal(pv.percent === null ? null : `${pv.percent}%`)
        : field === 'scope'
          ? pv.scope
          : field === 'shipping'
            ? pv.shipping
            : fmtVal(pv.dayMonth),
  }));
}

/** The one focused AMBIGUOUS question for the first unresolvable field/side. */
export function ambiguousQuestion(lang: Lang, side: VerdictSide, field: VerdictField): string {
  return t(lang, 'ambiguous_question', { side: t(lang, SIDE_KEY[side]), field: t(lang, FIELD_KEY[field]) });
}

const FIELD_ORDER: VerdictField[] = ['percent', 'scope', 'shipping', 'valid_until'];

/**
 * Decide the verdict from the comparison table + known repair blockers.
 * Precedence (section 5 table): both wrong → ad wrong → page wrong →
 * unresolvable → clean. CAPTURE_FAILED is operational and never becomes CLEAN.
 */
export function decideVerdict(input: VerdictInput): VerdictOutput {
  const { spec, ad, page, captureFailed, repairBlockers, lang } = input;
  if (captureFailed || page === null) {
    return { verdict: 'CAPTURE_FAILED', comparisons: [], findings: [], question: null };
  }

  const comparisons = buildComparisons(spec, ad, page);
  const byField = new Map(comparisons.map((c) => [c.field, c]));
  const adContradicts = comparisons.some((c) => c.ad === 'contradict');
  const pageContradicts = comparisons.some((c) => c.page === 'contradict');

  const findings: Finding[] = [];
  let n = 0;
  const pushFinding = (f: Omit<Finding, 'id'>): void => {
    n += 1;
    findings.push({ ...f, id: `f${n}` });
  };

  for (const field of FIELD_ORDER) {
    const c = byField.get(field) as FieldComparison;
    for (const side of ['ad', 'page'] as const) {
      const status = side === 'ad' ? c.ad : c.page;
      const observed = side === 'ad' ? c.adObserved : c.pageObserved;
      if (status === 'contradict') {
        const sideText = t(lang, SIDE_KEY[side]);
        const fieldText = t(lang, FIELD_KEY[field]);
        pushFinding({
          kind: 'contradiction',
          side,
          field,
          specValue: c.spec,
          observedValue: observed,
          evidenceIds: [
            ...(side === 'ad' ? evidenceForAd(ad, field) : evidenceForPage(page, field)),
            SPEC_EVIDENCE_ID[field],
          ],
          detail: t(lang, 'finding_contradiction', { side: sideText, observed, field: fieldText, spec: c.spec }),
          messageKey: 'finding_contradiction',
          vars: { side, field, observed, spec: c.spec },
        });
      } else if (status === 'unknown') {
        const sideText = t(lang, SIDE_KEY[side]);
        const fieldText = t(lang, FIELD_KEY[field]);
        pushFinding({
          kind: 'missing',
          side,
          field,
          specValue: c.spec,
          observedValue: observed,
          evidenceIds: [
            ...(side === 'ad' ? evidenceForAd(ad, field) : evidenceForPage(page, field)),
            SPEC_EVIDENCE_ID[field],
          ],
          detail: t(lang, 'finding_missing', { side: sideText, field: fieldText }),
          messageKey: 'finding_missing',
          vars: { side, field },
        });
      }
    }
  }

  let verdict: Verdict;
  let question: string | null = null;

  if (adContradicts && pageContradicts) {
    verdict = 'AD_WRONG_UNSAFE';
    const detail = comparisons
      .filter((c) => c.page === 'contradict')
      .map((c) => `${c.field}: ${c.pageObserved}`)
      .join('; ');
    pushFinding({
      kind: 'page_wrong',
      side: 'page',
      field: null,
      specValue: null,
      observedValue: null,
      evidenceIds: comparisons.filter((c) => c.page === 'contradict').flatMap((c) => evidenceForPage(page, c.field)),
      detail: t(lang, 'finding_page_wrong', { detail }),
      messageKey: 'finding_page_wrong',
      vars: { detail },
    });
  } else if (adContradicts) {
    verdict = repairBlockers.length > 0 ? 'AD_WRONG_UNSAFE' : 'AD_WRONG_REPAIRABLE';
  } else if (pageContradicts) {
    verdict = 'PAGE_WRONG';
  } else {
    const unknown = comparisons.find((c) => c.ad === 'unknown' || c.page === 'unknown');
    if (unknown) {
      verdict = 'AMBIGUOUS';
      const side: VerdictSide = unknown.ad === 'unknown' ? 'ad' : 'page';
      question = ambiguousQuestion(lang, side, unknown.field);
    } else {
      verdict = 'CLEAN';
    }
  }

  for (const blocker of repairBlockers) {
    pushFinding({
      kind: 'repair_blocker',
      side: null,
      field: null,
      specValue: null,
      observedValue: blocker,
      evidenceIds: ['ad:panel'],
      detail: t(lang, 'finding_repair_blocker', { blocker }),
      messageKey: 'finding_repair_blocker',
      vars: { blocker },
    });
  }

  return { verdict, comparisons, findings, question };
}
