/**
 * Bilingual user-facing strings (Hebrew + English).
 *
 * Every user-visible message the repair pipeline and kill-test scripts print
 * lives here — blocker reasons, proof summary lines, verdict names,
 * revalidation messages, table headers. Code references message keys, never
 * inline user text, so the future UI can reuse this dictionary as-is.
 * Scripts print English by default, Hebrew with `--lang he`.
 */
export type Lang = 'he' | 'en';

const en = {
  verdict_clean: 'CLEAN',
  verdict_repaired: 'REPAIRED',
  verdict_refused: 'REFUSED',
  verdict_ad_wrong_repairable: 'AD_WRONG_REPAIRABLE',
  verdict_ad_wrong_unsafe: 'AD_WRONG_UNSAFE',
  verdict_page_wrong: 'PAGE_WRONG',
  verdict_ambiguous: 'AMBIGUOUS',
  verdict_capture_failed: 'CAPTURE_FAILED',
  verdict_unsupported_format: 'UNSUPPORTED_FORMAT',

  blocker_panel_not_opaque: 'Offer panel is not opaque (background shows through)',
  blocker_panel_overlaps_protected: 'Offer panel overlaps the protected product/logo area',
  blocker_wrong_text_outside_panel: 'Offer text outside the panel contradicts the approved offer',
  blocker_text_does_not_fit: 'Corrected text does not fit the panel at the minimum font size',
  blocker_protected_mask_empty: 'Protected product/logo mask is empty',
  blocker_protected_mask_tiny: 'Protected product/logo mask is too small to trust',
  blocker_panel_not_found: 'No single opaque offer panel found to repair',

  proof_changed_outside: 'changed pixels outside panel: {count}',
  proof_changed_protected: 'changed pixels inside protected area: {count}',
  proof_max_diff: 'max channel difference outside panel: {diff}',
  proof_roundtrip_ok: 'PNG round-trip check: OK',
  proof_roundtrip_fail: 'PNG round-trip check: FAILED',
  proof_pass: 'pixel proof: PASS',
  proof_fail: 'pixel proof: FAIL',

  reval_pass: 'revalidation: PASS — the repaired ad matches the approved offer',
  reval_fail: 'revalidation: FAIL',
  reval_field_mismatch: '{field}: got {got}, want {want}',
  reval_old_promise: 'old promise still present: {detail}',
  reval_new_promise: 'new unsupported promise: {detail}',
  reval_language_changed: 'offer language changed: was {before}, now {after}',

  hdr_ad: 'Ad',
  hdr_expected: 'Expected',
  hdr_got: 'Got',
  hdr_result: 'Result',
  hdr_detail: 'Detail',
  hdr_language: 'Lang',
  hdr_cached: 'Cache',
  hdr_latency: 'Latency',
  hdr_calls: 'Calls',
  word_pass: 'PASS',
  word_fail: 'FAIL',
  word_cached: 'cached',
  word_fresh: 'fresh',

  field_percent: 'discount percent',
  field_scope: 'offer scope',
  field_shipping: 'shipping terms',
  field_valid_until: 'expiry date',
  side_ad: 'the ad',
  side_page: 'the landing page',

  ambiguous_question: 'The {side} does not state a clear {field}. What value should the approved offer be checked against?',
  finding_contradiction: '{side} says {observed} for {field}, but the approved offer says {spec}',
  finding_missing: '{side} does not state {field}',
  finding_page_wrong: 'landing page contradicts the approved offer ({detail})',
  finding_repair_blocker: 'repair blocked: {blocker}',

  capture_failed: 'page capture failed: {reason}',

  sweep_title: 'Campaign sweep (snapshot → extract → capture → compare → verdict → repair)',
  sweep_all_pass: 'SWEEP: ALL PASS',
  sweep_failures: 'SWEEP: FAILURES PRESENT',
  sweep_cache_hit: 'cache hit — reused results captured at {time}',
  sweep_using_pages: 'landing pages: {base}',
  sweep_using_db: 'store: {path}',

  seed_title: 'Seed the real test campaign (one PAUSED ad per manifest entry)',
  seed_dry_note: 'DRY RUN: payloads below are printed, not sent. A human runs with --execute.',
  seed_done: 'Seed dry run complete. No writes were sent.',
  seed_execute_done: 'Seed complete: {ads} PAUSED ads created and verified.',

  line_latency: 'latency: {ms} ms',
  line_model_calls: 'model calls: {count}',
  line_api_calls: 'API calls: {count}',
  line_usage: 'tokens: in={in} out={out} total={total}',
  line_artifacts: 'artifacts: {dir}',

  killtest_spark_title: 'Kill test: ad extraction (Spark 1.3)',
  killtest_repair_title: 'Kill test: repair proof (Chromium render + pixel proof + revalidation)',
  spark_all_pass: 'SPARK KILL TEST: ALL PASS',
  spark_failures: 'SPARK KILL TEST: FAILURES PRESENT',
  repair_all_pass: 'REPAIR KILL TEST: ALL PASS',
  repair_failures: 'REPAIR KILL TEST: FAILURES PRESENT',
} as const;

export type MessageKey = keyof typeof en;

const he: Record<MessageKey, string> = {
  verdict_clean: 'תקינה',
  verdict_repaired: 'תוקנה',
  verdict_refused: 'סורבה',
  verdict_ad_wrong_repairable: 'מודעה שגויה — ניתנת לתיקון',
  verdict_ad_wrong_unsafe: 'מודעה שגויה — מסוכן לתקן',
  verdict_page_wrong: 'האתר שגוי',
  verdict_ambiguous: 'לא ברור',
  verdict_capture_failed: 'צילום האתר נכשל',
  verdict_unsupported_format: 'פורמט לא נתמך',

  blocker_panel_not_opaque: 'פאנל המבצע אינו אטום (הרקע נראה מבעדו)',
  blocker_panel_overlaps_protected: 'פאנל המבצע חופף לאזור המוגן של המוצר/הלוגו',
  blocker_wrong_text_outside_panel: 'טקסט מבצע מחוץ לפאנל סותר את המבצע המאושר',
  blocker_text_does_not_fit: 'הטקסט המתוקן אינו נכנס בפאנל בגודל הגופן המינימלי',
  blocker_protected_mask_empty: 'מסכת ההגנה של המוצר/הלוגו ריקה',
  blocker_protected_mask_tiny: 'מסכת ההגנה של המוצר/הלוגו קטנה מכדי לסמוך עליה',
  blocker_panel_not_found: 'לא נמצא פאנל מבצע יחיד לתיקון',

  proof_changed_outside: 'פיקסלים שהשתנו מחוץ לפאנל: {count}',
  proof_changed_protected: 'פיקסלים שהשתנו באזור המוגן: {count}',
  proof_max_diff: 'הפרש ערוץ מקסימלי מחוץ לפאנל: {diff}',
  proof_roundtrip_ok: 'בדיקת PNG חוזרת: תקין',
  proof_roundtrip_fail: 'בדיקת PNG חוזרת: נכשל',
  proof_pass: 'הוכחת פיקסלים: עבר',
  proof_fail: 'הוכחת פיקסלים: נכשל',

  reval_pass: 'אימות חוזר: עבר — המודעה המתוקנת תואמת למבצע המאושר',
  reval_fail: 'אימות חוזר: נכשל',
  reval_field_mismatch: '{field}: נמצא {got}, נדרש {want}',
  reval_old_promise: 'הבטחה ישנה עדיין מופיעה: {detail}',
  reval_new_promise: 'הבטחה חדשה לא נתמכת: {detail}',
  reval_language_changed: 'שפת המבצע השתנתה: הייתה {before}, כעת {after}',

  hdr_ad: 'מודעה',
  hdr_expected: 'צפוי',
  hdr_got: 'התקבל',
  hdr_result: 'תוצאה',
  hdr_detail: 'פירוט',
  hdr_language: 'שפה',
  hdr_cached: 'מטמון',
  hdr_latency: 'זמן',
  hdr_calls: 'קריאות',
  word_pass: 'עבר',
  word_fail: 'נכשל',
  word_cached: 'מהמטמון',
  word_fresh: 'טרי',

  field_percent: 'אחוז ההנחה',
  field_scope: 'היקף המבצע',
  field_shipping: 'תנאי המשלוח',
  field_valid_until: 'תאריך התפוגה',
  side_ad: 'מודעה',
  side_page: 'עמוד הנחיתה',

  ambiguous_question: 'ב{side} לא מופיע {field} ברור. מול איזה ערך מאושר יש לבדוק?',
  finding_contradiction: 'ב{side} כתוב {observed} עבור {field}, אבל במבצע המאושר כתוב {spec}',
  finding_missing: 'ב{side} לא מופיע {field}',
  finding_page_wrong: 'עמוד הנחיתה סותר את המבצע המאושר ({detail})',
  finding_repair_blocker: 'התיקון נחסם: {blocker}',

  capture_failed: 'צילום העמוד נכשל: {reason}',

  sweep_title: 'סריקת קמפיין (צילום → חילוץ → צילום אתר → השוואה → החלטה → תיקון)',
  sweep_all_pass: 'סריקה: הכל עבר',
  sweep_failures: 'סריקה: יש כשלונות',
  sweep_cache_hit: 'נמצא במטמון — נעשה שימוש חוזר בתוצאות מ-{time}',
  sweep_using_pages: 'עמודי נחיתה: {base}',
  sweep_using_db: 'מסד נתונים: {path}',

  seed_title: 'זריעת קמפיין הבדיקה האמיתי (מודעה מושהית אחת לכל רשומה)',
  seed_dry_note: 'הרצת יבשה: המטענים מודפסים, לא נשלחים. אדם יריץ עם --execute.',
  seed_done: 'הרצת הזריעה היבשה הסתיימה. דבר לא נשלח.',
  seed_execute_done: 'הזריעה הסתיימה: {ads} מודעות מושהיות נוצרו ואומתו.',

  line_latency: 'זמן: {ms} מ״ש',
  line_model_calls: 'קריאות מודל: {count}',
  line_api_calls: 'קריאות API: {count}',
  line_usage: 'טוקנים: in={in} out={out} total={total}',
  line_artifacts: 'קבצים: {dir}',

  killtest_spark_title: 'מבחן חיסול: חילוץ מודעה (Spark 1.3)',
  killtest_repair_title: 'מבחן חיסול: הוכחת תיקון (רינדור Chromium + הוכחת פיקסלים + אימות חוזר)',
  spark_all_pass: 'מבחן SPARK: הכל עבר',
  spark_failures: 'מבחן SPARK: יש כשלונות',
  repair_all_pass: 'מבחן REPAIR: הכל עבר',
  repair_failures: 'מבחן REPAIR: יש כשלונות',
};

export const STRINGS: Record<Lang, Record<MessageKey, string>> = { he, en };

/** Render a message key in the requested language, filling {vars}. */
export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const found: string | undefined = STRINGS[lang][key];
  if (found === undefined) throw new Error(`unknown message key: ${JSON.stringify(key)}`);
  let out: string = found;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.split(`{${name}}`).join(String(value));
    }
  }
  return out;
}

/** `--lang he` selects Hebrew; anything else (or absent) is English. */
export function parseLang(argv: readonly string[]): Lang {
  const i = argv.indexOf('--lang');
  return i >= 0 && argv[i + 1] === 'he' ? 'he' : 'en';
}
