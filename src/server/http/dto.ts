import { PRESETS } from '../../shared/presets.js';
import { Store, type BrandRow, type JobRow, type OutputRow, type TemplateRow } from '../store/db.js';

export interface TemplateDto {
  id: string;
  preset: string | null;
  image: string;
  status: string;
  error: string | null;
  spec: unknown;
  frame: string | null;
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

function templateDto(t: TemplateRow): TemplateDto {
  let spec: unknown = null;
  try {
    spec = t.spec_json ? JSON.parse(t.spec_json) : null;
  } catch {
    spec = null;
  }
  return {
    id: t.id,
    preset: t.preset,
    image: `media/template/${t.id}`,
    status: t.status,
    error: t.error,
    spec,
    frame: t.frame_path ? `media/frame/${t.id}` : null,
  };
}

function brandDto(b: BrandRow, templates: TemplateRow[]): BrandDto {
  let colors: string[] = [];
  let fonts: string[] = [];
  try {
    colors = JSON.parse(b.colors_json) as string[];
    fonts = JSON.parse(b.fonts_json) as string[];
  } catch {
    // Corrupt rows render with empty lists, never crash the API.
  }
  return {
    id: b.id,
    name: b.name,
    colors,
    fonts,
    logo: b.logo_path ? `media/logo/${b.id}` : null,
    demo: b.is_demo === 1,
    templates: templates.map(templateDto),
  };
}

export function buildBrands(s: Store): { presets: typeof PRESETS; brands: BrandDto[] } {
  const brands = s.allBrands().map((b) => brandDto(b, s.templatesForBrand(b.id)));
  return { presets: PRESETS, brands };
}

export function buildBrand(s: Store, id: string): BrandDto | null {
  const b = s.getBrand(id);
  if (!b) return null;
  return brandDto(b, s.templatesForBrand(id));
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

function outputCard(o: OutputRow, sources: string[]): OutputCardDto {
  let qaPass: boolean | null = null;
  try {
    const qa = o.qa_json ? (JSON.parse(o.qa_json) as { pass?: boolean }) : null;
    qaPass = typeof qa?.pass === 'boolean' ? qa.pass : null;
  } catch {
    qaPass = null;
  }
  let proofDiff: number | null = null;
  try {
    const proof = o.proof_json ? (JSON.parse(o.proof_json) as Record<string, { core_differ?: number }>) : null;
    proofDiff = proof ? Object.values(proof).reduce((s, p) => s + (p.core_differ ?? 0), 0) : null;
  } catch {
    proofDiff = null;
  }
  return {
    id: o.id,
    sourceId: o.source_id,
    sourceIndex: Math.max(0, sources.indexOf(o.source_id)),
    preset: o.preset,
    mode: o.mode,
    status: o.status,
    image: `media/output/${o.id}`,
    qaPass,
    retries: o.retries,
    proofDiff,
  };
}

function jobDto(j: JobRow, outputs: OutputRow[]): JobDto {
  let sizes: string[] = [];
  let sources: string[] = [];
  try {
    sizes = JSON.parse(j.sizes_json) as string[];
    sources = JSON.parse(j.sources_json) as string[];
  } catch {
    // Corrupt rows render with empty lists, never crash the API.
  }
  return {
    id: j.id,
    brandId: j.brand_id,
    mode: j.mode,
    sizes,
    sources,
    status: j.status,
    error: j.error,
    modelCalls: j.model_calls,
    imageCalls: j.image_calls,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    outputs: outputs.map((o) => outputCard(o, sources)),
  };
}

export function buildJob(s: Store, id: string): JobDto | null {
  const j = s.getJob(id);
  if (!j) return null;
  return jobDto(j, s.outputsForJob(id));
}

export interface OutputDetailDto extends OutputCardDto {
  jobId: string;
  plan: unknown;
  proof: unknown;
  qa: unknown;
  trace: unknown[];
  error: string | null;
  latencyMs: number;
  sourceImage: string;
  sourceWidth: number;
  sourceHeight: number;
  templateImage: string | null;
  masks: string[];
}

export function buildOutput(s: Store, id: number): OutputDetailDto | null {
  const o = s.getOutput(id);
  if (!o) return null;
  const job = s.getJob(o.job_id);
  let sources: string[] = [];
  try {
    sources = job ? (JSON.parse(job.sources_json) as string[]) : [];
  } catch {
    sources = [];
  }
  const parse = (v: string | null): unknown => {
    if (!v) return null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  const plan = parse(o.plan_json) as { template_id?: string } | null;
  const source = s.getSource(o.source_id);
  let masks: string[] = [];
  try {
    const map = source?.masks_json ? (JSON.parse(source.masks_json) as Record<string, string>) : {};
    masks = Object.keys(map);
  } catch {
    masks = [];
  }
  const templateImage = plan?.template_id ? `media/template/${plan.template_id}` : null;
  return {
    ...outputCard(o, sources),
    jobId: o.job_id,
    plan,
    proof: parse(o.proof_json),
    qa: parse(o.qa_json),
    trace: (parse(o.trace_json) as unknown[]) ?? [],
    error: o.error,
    latencyMs: o.latency_ms,
    sourceImage: `media/source/${o.source_id}`,
    sourceWidth: source?.width ?? 0,
    sourceHeight: source?.height ?? 0,
    templateImage,
    masks,
  };
}
