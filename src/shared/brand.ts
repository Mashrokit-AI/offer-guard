/** Working product name in exactly one place, so it can be renamed later. */
export const BRAND_NAME = 'MatchPic';

/** URL/filename-safe slug derived from the name (export names follow renames). */
export const BRAND_SLUG = BRAND_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
