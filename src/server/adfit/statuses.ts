import { z } from 'zod';

/**
 * Three independent verification statuses per output — Protected pixels,
 * Text, Layout review — each Pending / Passed / Fixed / Needs review.
 * Replaces the single "Checked by Spark" badge.
 */

export const checkStatusSchema = z.enum(['pending', 'passed', 'fixed', 'needs_review']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const checkEntrySchema = z.object({ status: checkStatusSchema, detail: z.string() });
export type CheckEntry = z.infer<typeof checkEntrySchema>;

export const outputChecksSchema = z.object({
  protected_pixels: checkEntrySchema,
  text: checkEntrySchema,
  layout_review: checkEntrySchema,
  /** Set when the single repair pass recomposed the output. */
  repaired: z
    .object({
      before: z.string(),
      patches: z.array(z.string()),
    })
    .nullable()
    .default(null),
});
export type OutputChecks = z.infer<typeof outputChecksSchema>;

export function pendingChecks(detail = 'not checked yet'): OutputChecks {
  const p = (d: string): CheckEntry => ({ status: 'pending', detail: d });
  return { protected_pixels: p(detail), text: p(detail), layout_review: p(detail), repaired: null };
}

/** Row status from checks: failed stays failed; needs_review when any check needs it. */
export function rowStatusFromChecks(checks: OutputChecks): 'pass' | 'needs_review' {
  const all = [checks.protected_pixels.status, checks.text.status, checks.layout_review.status];
  return all.every((s) => s === 'passed' || s === 'fixed') ? 'pass' : 'needs_review';
}
