import type { ResolvedLayoutManifest } from './manifest.js';
import { minLegiblePx } from '../repair/render.js';
import type { SourceAnalysis } from '../../shared/schemas.js';

/**
 * Deterministic geometry/text checks. They run FIRST on every composed
 * output, their results go into the Wonder review prompt, and anything still
 * failing after the single repair pass marks the output "Needs review".
 */

export type CheckSeverity = 'fail' | 'warn';

export interface GeometryFinding {
  code: string;
  severity: CheckSeverity;
  element: string | null;
  detail: string;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function intersectArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/**
 * Check one resolved manifest against the hard layout contract. Pure and
 * fast — no models. `renderedSizes` maps text element ids to the actual
 * rendered font px (from Chromium) for the legibility check.
 */
export function checkManifestGeometry(
  manifest: ResolvedLayoutManifest,
  analysis: SourceAnalysis,
  renderedSizes: Record<string, number[]> = {},
): GeometryFinding[] {
  const out: GeometryFinding[] = [];
  const W = manifest.width;
  const H = manifest.height;
  const safe = manifest.safe;
  const margin = Math.round(Math.min(W, H) * 0.06);
  const tall = H / W >= 1.5;
  const wide = W / H > 1.3;
  const inSafe = (b: { x: number; y: number; w: number; h: number }): boolean =>
    b.x >= safe.x && b.y >= safe.y && b.x + b.w <= safe.x + safe.w && b.y + b.h <= safe.y + safe.h;

  for (const e of manifest.elements) {
    if (e.kind === 'frame' || e.kind === 'shadow') continue;
    // Safe area.
    if (!inSafe(e.box)) {
      out.push({ code: 'safe_area', severity: 'fail', element: e.id, detail: `${e.id} leaves the safe area` });
    }
    // 6% margin.
    if (e.box.x < margin || e.box.y < margin || e.box.x + e.box.w > W - margin || e.box.y + e.box.h > H - margin) {
      out.push({ code: 'margin', severity: 'fail', element: e.id, detail: `${e.id} closer than 6% of the short side to the canvas edge` });
    }
  }

  // Overlaps: ANY box collision fails, including text nested in the panel
  // (panel-carried strings have no element, so a free-text box inside the
  // panel box always renders over the panel's own text — seen live as a
  // subtext stamped across "$39"). No nesting exemption at this level.
  const els = manifest.elements.filter((e) => e.kind !== 'frame' && e.kind !== 'shadow');
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i]!;
      const b = els[j]!;
      if (!overlaps(a.box, b.box)) continue;
      out.push({ code: 'overlap', severity: 'fail', element: a.id, detail: `${a.id} overlaps ${b.id}` });
    }
  }

  // Product size floors.
  for (const e of manifest.elements) {
    if (e.kind !== 'product') continue;
    if (tall && e.box.h < Math.round(safe.h * 0.45)) {
      out.push({ code: 'product_size', severity: 'warn', element: e.id, detail: `${e.id} below 45% of safe height on 9:16` });
    }
    if (wide && e.box.h < Math.round(H * 0.7)) {
      out.push({ code: 'product_size', severity: 'warn', element: e.id, detail: `${e.id} below 70% of canvas height on landscape` });
    }
  }

  // Text group: one shared alignment edge.
  const texts = manifest.elements.filter((e) => e.group === 'text');
  const edges = new Set(texts.map((t) => t.align));
  if (edges.size > 1) {
    out.push({ code: 'text_align', severity: 'warn', element: null, detail: `text group mixes alignment edges (${[...edges].join(',')})` });
  }

  // Legibility: rendered text must clear the floor for this canvas.
  const floor = minLegiblePx(Math.min(W, H));
  for (const [id, sizes] of Object.entries(renderedSizes)) {
    for (const s of sizes) {
      if (s < floor) {
        out.push({ code: 'text_size', severity: 'fail', element: id, detail: `${id} rendered at ${s}px, below the ${floor}px legible floor` });
      }
    }
  }

  // Empty band > 25% of canvas height.
  const rows = 40;
  const rowH = H / rows;
  const covered = new Array(rows).fill(false);
  for (const e of manifest.elements) {
    if (e.kind === 'frame' || e.kind === 'shadow') continue;
    const r1 = Math.max(0, Math.floor(e.box.y / rowH));
    const r2 = Math.min(rows - 1, Math.floor((e.box.y + e.box.h) / rowH));
    for (let r = r1; r <= r2; r++) covered[r] = true;
  }
  let gapStart = -1;
  for (let r = 0; r <= rows; r++) {
    const isGap = r < rows && !covered[r];
    if (isGap && gapStart < 0) gapStart = r;
    if (!isGap && gapStart >= 0) {
      if ((r - gapStart) * rowH > H * 0.25) {
        out.push({ code: 'empty_band', severity: 'warn', element: null, detail: `empty band over 25% of canvas height (rows ${gapStart}-${r})` });
      }
      gapStart = -1;
    }
  }

  // Coverage: every analyzed element must be placed (nothing vanishes silently).
  const ids = new Set(manifest.elements.map((e) => e.id));
  analysis.products.forEach((_, i) => {
    if (!ids.has(`product-${i}`)) out.push({ code: 'missing_element', severity: 'fail', element: `product-${i}`, detail: `product-${i} not placed` });
  });
  if (analysis.logo_bbox && !ids.has('logo')) {
    out.push({ code: 'missing_element', severity: 'fail', element: 'logo', detail: 'logo not placed' });
  }
  // Headline/subtext travel with pasted panel pixels when a panel exists, so
  // they are not required to have their own manifest elements.
  return out;
}

/** True when no failing (vs warning) findings remain. */
export function checksPass(findings: GeometryFinding[]): boolean {
  return !findings.some((f) => f.severity === 'fail');
}
