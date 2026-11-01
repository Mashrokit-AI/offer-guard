export interface PresetDto {
  id: string;
  label: string;
  width: number;
  height: number;
  safe: { top: number; bottom: number; left: number; right: number };
  meta: boolean;
}

export interface TemplateDto {
  id: string;
  preset: string | null;
  image: string;
  status: string;
  error: string | null;
  spec: TemplateSpecDto | null;
  frame: string | null;
}

export interface NormBoxDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateSpecDto {
  logo: { box: NormBoxDto; corner: string } | null;
  headline_zone: NormBoxDto | null;
  subtext_zone: NormBoxDto | null;
  panel_zone: { box: NormBoxDto; color: string; shape: string } | null;
  product_zone: NormBoxDto | null;
  frames: Array<{ box: NormBoxDto; color: string; edge: string; kind: string }>;
  background_style: string;
  text_align: string;
  direction: string;
}

export interface BrandDto {
  id: string;
  name: string;
  colors: string[];
  fonts: string[];
  logo: string | null;
  demo: boolean;
  templates: TemplateDto[];
}

export interface OutputCardDto {
  id: number;
  sourceId: string;
  sourceIndex: number;
  preset: string;
  mode: string;
  status: string;
  image: string;
  qaPass: boolean | null;
  retries: number;
  proofDiff: number | null;
}

export interface JobDto {
  id: string;
  brandId: string | null;
  mode: string;
  sizes: string[];
  sources: string[];
  status: string;
  error: string | null;
  modelCalls: number;
  imageCalls: number;
  createdAt: string;
  finishedAt: string | null;
  outputs: OutputCardDto[];
}

export interface TraceEventDto {
  seq: number;
  step: string;
  tool_or_model: string;
  input_summary: string;
  output_summary: string;
  duration_ms: number;
  evidence_ids: string[];
  next_state: string;
  cached: boolean;
}

export interface OutputDetailDto extends OutputCardDto {
  jobId: string;
  plan: {
    preset: string;
    width: number;
    height: number;
    from_template: boolean;
    template_id: string | null;
    safe: { x: number; y: number; w: number; h: number };
    logo: { x: number; y: number; w: number; h: number } | null;
    products: Array<{ x: number; y: number; w: number; h: number }>;
    headline: { x: number; y: number; w: number; h: number } | null;
    subtext: { x: number; y: number; w: number; h: number } | null;
    panel: { x: number; y: number; w: number; h: number } | null;
    other_texts: Array<{ x: number; y: number; w: number; h: number }>;
    product_scales: number[];
    logo_scale: number | null;
    notes: string[];
  } | null;
  proof: Record<string, { scale: number; core_differ: number; core_total: number; feather_total: number; pass: boolean }> | null;
  qa: {
    pass: boolean;
    reasons: string[];
    texts_read: Array<{ expected: string; found: string; exact: boolean }>;
    logo_ok: boolean;
    product_ok: boolean;
    safe_area_ok: boolean;
    invented_text: string[];
  } | null;
  trace: TraceEventDto[];
  error: string | null;
  latencyMs: number;
  sourceImage: string;
  sourceWidth: number;
  sourceHeight: number;
  templateImage: string | null;
  masks: string[];
}
