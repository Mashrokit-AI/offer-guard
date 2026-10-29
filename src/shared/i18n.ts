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
  word_pass: 'PASS',
  word_fail: 'FAIL',

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
  word_pass: 'עבר',
  word_fail: 'נכשל',

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
  let out: string = STRINGS[lang][key];
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
