import { z } from 'zod';

/**
 * Bounding box in source pixels, half-open: covers [x, x+w) x [y, y+h).
 * The schema accepts any finite numbers so a slightly floaty model response
 * still validates; coordinates are rounded after parsing.
 */
export const bboxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});

export type BBox = z.infer<typeof bboxSchema>;

/**
 * Normalized box: 0-1 relative to image width/height once stored. The schema
 * accepts any finite numbers because the model sometimes answers in pixels
 * or 0-1000 despite the prompt — normalizeTemplateSpec converts to 0-1
 * before anything is stored. The PATCH boundary re-checks the range.
 */
export const normBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});

export type NormBox = z.infer<typeof normBoxSchema>;

export const languageSchema = z.enum(['he', 'en']);

export type AdLanguage = z.infer<typeof languageSchema>;

export const directionSchema = z.enum(['rtl', 'ltr']);

export type TextDirection = z.infer<typeof directionSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must look like #rrggbb');

// --- Source analysis (Spark reads the uploaded creative) ---

export const analyzedProductSchema = z.object({
  /** Short label, e.g. "thermal bottle". */
  label: z.string(),
  /** Noun phrase for the SAM phrase prompt, e.g. "bottle". */
  sam_phrase: z.string(),
  bbox: bboxSchema,
});

export type AnalyzedProduct = z.infer<typeof analyzedProductSchema>;

export const analyzedTextSchema = z.object({
  /** Verbatim printed text, exactly as printed. */
  text: z.string(),
  bbox: bboxSchema,
  /** Approximate weight / color sampled from the source (for re-rendering). */
  bold: z.boolean(),
  color: hexColor,
});

export type AnalyzedText = z.infer<typeof analyzedTextSchema>;

export const analyzedPanelSchema = z.object({
  bbox: bboxSchema,
  opaque: z.boolean(),
  bg_color: hexColor,
  text_color: hexColor,
  /** Verbatim lines printed inside the panel, in reading order. */
  texts: z.array(z.string()),
});

export type AnalyzedPanel = z.infer<typeof analyzedPanelSchema>;

export const sourceAnalysisSchema = z.object({
  language: languageSchema,
  direction: directionSchema,
  products: z.array(analyzedProductSchema),
  logo_bbox: bboxSchema.nullable(),
  headline: analyzedTextSchema.nullable(),
  subtext: analyzedTextSchema.nullable(),
  panel: analyzedPanelSchema.nullable(),
  /** Every other printed string (taglines, disclaimers) — nothing may vanish silently. */
  other_texts: z.array(analyzedTextSchema),
  background: z.object({
    type: z.enum(['flat', 'gradient', 'photo', 'other']),
    description: z.string(),
    colors: z.array(hexColor),
  }),
  unreadable: z.array(z.string()),
});

export type SourceAnalysis = z.infer<typeof sourceAnalysisSchema>;

// --- Template layout spec (Spark reads a brand template; zones are 0-1) ---

export const templateFrameSchema = z.object({
  box: normBoxSchema,
  color: hexColor,
  /** Which edge the element hugs: top/bottom/left/right/corner/free. */
  edge: z.enum(['top', 'bottom', 'left', 'right', 'corner', 'free']),
  kind: z.enum(['band', 'tab', 'corner_shape', 'border', 'other']),
});

export type TemplateFrame = z.infer<typeof templateFrameSchema>;

export const templateSpecSchema = z.object({
  logo: z.object({ box: normBoxSchema, corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'other']) }).nullable(),
  headline_zone: normBoxSchema.nullable(),
  subtext_zone: normBoxSchema.nullable(),
  panel_zone: z.object({ box: normBoxSchema, color: hexColor, shape: z.enum(['rounded_rect', 'rect', 'pill', 'other']) }).nullable(),
  product_zone: normBoxSchema.nullable(),
  frames: z.array(templateFrameSchema),
  background_style: z.string(),
  text_align: z.enum(['start', 'center', 'end']),
  direction: directionSchema,
});

export type TemplateSpec = z.infer<typeof templateSpecSchema>;

// --- QA verdict (a fresh Spark call reads every output) ---

export const qaVerdictSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()),
  /** Every verbatim source text and whether it appears exactly in the output. */
  texts_read: z.array(z.object({ expected: z.string(), found: z.string(), exact: z.boolean() })),
  logo_ok: z.boolean(),
  product_ok: z.boolean(),
  safe_area_ok: z.boolean(),
  /** Text present in the output that was not in the source (must be empty). */
  invented_text: z.array(z.string()),
});

export type QAverdict = z.infer<typeof qaVerdictSchema>;

// --- Layout plan (data, produced by code from template zones or defaults) ---

export const planBoxSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
});

export type PlanBox = z.infer<typeof planBoxSchema>;

export const layoutPlanSchema = z.object({
  preset: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  /** true when a brand template supplied the zones, false for default rules. */
  from_template: z.boolean(),
  template_id: z.string().nullable(),
  safe: planBoxSchema,
  logo: planBoxSchema.nullable(),
  products: z.array(planBoxSchema),
  headline: planBoxSchema.nullable(),
  subtext: planBoxSchema.nullable(),
  panel: planBoxSchema.nullable(),
  /** One box per analysis.other_texts, same order: relative-mapped + clamped. */
  other_texts: z.array(planBoxSchema),
  /** Per-product scale applied to the SAM-cut pixels (uniform, no stretch). */
  product_scales: z.array(z.number()),
  logo_scale: z.number().nullable(),
  notes: z.array(z.string()),
});

export type LayoutPlan = z.infer<typeof layoutPlanSchema>;
