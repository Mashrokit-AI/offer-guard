import { api, bboxDiv, BRAND_SLUG, dims, errText, fmtDur, h, modeBadge, modelFooter, presetName, qaBadge, t, type Lang } from './lib.js';
import type { OutputDetailDto, PresetDto } from './dto.js';

/** Load a grayscale mask PNG and paint it tinted onto a canvas overlay. */
async function maskCanvas(url: string, color: string): Promise<HTMLCanvasElement | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('mask load failed'));
    });
    img.src = url;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvas.className = 'masklayer';
    return canvas;
  } catch {
    return null;
  }
}

export function outputView(lang: Lang, id: number): HTMLElement {
  const root = h('div', {});
  root.append(h('a', { class: 'back', href: '#/' }, `${lang === 'he' ? '→' : '←'} ${t(lang, 'detail_back')}`));
  const body = h('div', {}, h('p', { class: 'muted' }, '…'));
  root.append(body);

  void (async () => {
    let d: OutputDetailDto;
    let presets: PresetDto[] = [];
    try {
      d = (await api(`api/outputs/${id}`)) as OutputDetailDto;
      try {
        presets = ((await api('api/presets')) as { presets: PresetDto[] }).presets;
      } catch {
        presets = [];
      }
    } catch (e) {
      body.replaceChildren(h('p', {}, errText(lang, e)));
      return;
    }
    const preset = presets.find((p) => p.id === d.preset);
    const title = preset ? `${presetName(lang, preset.id, preset.label)} · ${dims(preset.width, preset.height)}` : d.preset;

    const head = h('div', { class: 'verdict-banner' },
      h('div', {},
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, qaBadge(lang, d.qaPass), modeBadge(lang, d.mode)),
        h('p', {}, title),
        modelFooter(d.models ?? [], d.traceMs ?? 0),
      ),
    );

    // --- before/after ---
    const beforeFrame = h('div', { class: 'img-frame' });
    const beforeImg = h('img', { src: d.sourceImage, alt: t(lang, 'detail_before') }) as HTMLImageElement;
    beforeFrame.append(beforeImg);
    const afterFrame = h('div', { class: 'img-frame' });
    const afterImg = h('img', { src: d.image, alt: t(lang, 'detail_after') }) as HTMLImageElement;
    afterFrame.append(afterImg);
    const pair = h('div', { class: 'evidence2' },
      h('div', { class: 'ev-col' }, h('h3', {}, t(lang, 'detail_before')), beforeFrame),
      h('div', { class: 'ev-col' }, h('h3', {}, t(lang, 'detail_after')), afterFrame),
    );

    // --- overlays ---
    const tglMasks = h('input', { type: 'checkbox', id: 'tgl-masks' }) as HTMLInputElement;
    const tglZones = h('input', { type: 'checkbox', id: 'tgl-zones' }) as HTMLInputElement;
    const tglSafe = h('input', { type: 'checkbox', id: 'tgl-safe' }) as HTMLInputElement;
    const toggles = h('div', { class: 'toggles' },
      // Saved fixtures carry no masks; a dead toggle would only confuse.
      d.masks.length > 0 ? h('label', {}, tglMasks, ` ${t(lang, 'toggle_masks')}`) : null,
      h('label', {}, tglZones, ` ${t(lang, 'toggle_zones')}`),
      h('label', {}, tglSafe, ` ${t(lang, 'toggle_safe')}`),
    );
    const maskLayerBefore = h('div', { class: 'overlay' });
    const maskLayerAfter = h('div', { class: 'overlay' });
    const zoneLayer = h('div', { class: 'overlay' });
    const safeLayer = h('div', { class: 'overlay' });
    beforeFrame.append(maskLayerBefore);
    afterFrame.append(maskLayerAfter, zoneLayer, safeLayer);

    tglMasks.addEventListener('change', () => {
      maskLayerBefore.replaceChildren();
      maskLayerAfter.replaceChildren();
      if (!tglMasks.checked || d.masks.length === 0) return;
      // Masks live in source space, so they overlay the before image exactly.
      const colors = ['rgba(0,179,255,0.55)', 'rgba(255,179,0,0.55)', 'rgba(255,79,216,0.55)'];
      d.masks.forEach((m, i) => {
        const url = `media/mask/${encodeURIComponent(d.sourceId)}/${encodeURIComponent(m)}`;
        void maskCanvas(url, colors[i % colors.length] as string).then((cv) => {
          if (cv && tglMasks.checked) {
            maskLayerBefore.append(cv);
            const legend = h('span', { class: 'tag' }, m);
            legend.style.cssText = 'position:absolute;bottom:4px;inset-inline-start:4px';
            maskLayerBefore.append(legend);
          }
        });
      });
    });
    const paintZones = (): void => {
      zoneLayer.replaceChildren();
      safeLayer.replaceChildren();
      if (!d.plan) return;
      if (tglZones.checked) {
        const W = d.plan.width;
        const H = d.plan.height;
        if (d.plan.logo) zoneLayer.append(bboxDiv(d.plan.logo, W, H, 'logo', t(lang, 'legend_logo')));
        d.plan.products.forEach((p, i) => zoneLayer.append(bboxDiv(p, W, H, 'product', `${t(lang, 'legend_product')} ${i + 1}`)));
        if (d.plan.panel) zoneLayer.append(bboxDiv(d.plan.panel, W, H, 'panel', t(lang, 'legend_panel')));
      }
      if (tglSafe.checked) safeLayer.append(bboxDiv(d.plan.safe, d.plan.width, d.plan.height, 'safe'));
    };
    tglZones.addEventListener('change', paintZones);
    tglSafe.addEventListener('change', paintZones);

    // --- proof ---
    const sections: HTMLElement[] = [head, pair, toggles];
    if (d.proof) {
      const rows = Object.entries(d.proof).map(([what, pr]) =>
        h('div', { class: 'proof-num' },
          h('div', { class: `v ${pr.pass ? 'ok' : 'bad'}` }, String(pr.core_differ)),
          h('div', { class: 'k' }, t(lang, 'proof_row', { what, diff: pr.core_differ, scale: pr.scale.toFixed(2) })),
        ),
      );
      sections.push(
        h('h2', {}, t(lang, 'proof_title')),
        h('div', { class: 'proof-nums' }, ...rows),
        h('p', { class: 'muted small' }, t(lang, 'proof_feather_note')),
      );
    }
    // --- QA ---
    if (d.qa) {
      const items = d.qa.texts_read.map((tr) =>
        h('li', {},
          h('blockquote', { dir: 'auto' }, tr.found || '—'),
          h('div', { class: 'muted small' }, `${t(lang, 'qa_read_back', { text: tr.expected })} — ${t(lang, tr.exact ? 'qa_exact' : 'qa_changed')}`),
        ),
      );
      const reasons = d.qa.reasons.length > 0 ? h('ul', { class: 'about-list' }, ...d.qa.reasons.map((r) => h('li', { dir: 'auto' }, r))) : null;
      const invented = d.qa.invented_text.length > 0 ? h('p', {}, t(lang, 'qa_invented', { text: d.qa.invented_text.join(' · ') })) : null;
      sections.push(h('h2', {}, t(lang, 'qa_title')), h('div', { class: 'card' }, h('ul', { class: 'quotes' }, ...items), reasons, invented));
    }
    if (d.error) sections.push(h('p', {}, d.error));

    // --- actions ---
    const regen = h('button', { type: 'button', class: 'btn secondary' }, t(lang, 'btn_regenerate')) as HTMLButtonElement;
    regen.addEventListener('click', async () => {
      regen.disabled = true;
      try {
        const res = (await api(`api/outputs/${id}/regenerate`, { method: 'POST' })) as { key: string };
        const es = new EventSource(`api/live/${res.key}/events`);
        es.onmessage = (m) => {
          try {
            const e = JSON.parse(m.data as string) as { type: string; row?: { outputId: number } };
            if ((e.type === 'done' || e.type === 'failed') && e.row) {
              es.close();
              window.location.hash = `#/output/${e.row.outputId}`;
            } else if (e.type === 'done' || e.type === 'failed') {
              es.close();
              regen.disabled = false;
            }
          } catch {
            // Malformed frame: keep waiting.
          }
        };
        es.onerror = () => {
          es.close();
          regen.disabled = false;
        };
      } catch {
        regen.disabled = false;
      }
    });
    const dl = h('a', { class: 'btn secondary', href: d.image, download: `${BRAND_SLUG}-${d.preset}.png` }, t(lang, 'btn_download')) as HTMLAnchorElement;
    sections.push(h('div', { class: 'toolbar' }, regen, dl));

    // --- trace ---
    const traceRows = d.trace.map((e) =>
      h('tr', {},
        h('td', {}, String(e.seq)),
        h('td', { dir: 'ltr' }, h('span', { class: 'model-tag' }, e.tool_or_model.startsWith('model:') ? e.tool_or_model.slice('model:'.length) : e.tool_or_model)),
        h('td', { dir: 'auto' }, `${e.input_summary} → ${e.output_summary}`),
        h('td', { dir: 'ltr' }, fmtDur(e.duration_ms)),
        h('td', {}, h('span', { class: `pill${e.cached ? '' : ' live'}` }, e.cached ? t(lang, 'trace_cached') : t(lang, 'trace_live'))),
      ),
    );
    const spark = d.trace.filter((e) => e.tool_or_model.startsWith('model:muse-spark')).length;
    const sam = d.trace.filter((e) => e.tool_or_model.startsWith('model:sam')).length;
    const images = d.trace.filter((e) => e.tool_or_model.startsWith('model:muse-image')).length;
    const other = d.trace.length - spark - sam - images;
    // Open by default on desktop so judges see the live model calls; closed
    // on small screens where it would push the images down.
    const desktop = window.matchMedia('(min-width: 900px)').matches;
    const details = h('details', { class: 'card', id: 'trace', style: 'margin-top:18px', ...(desktop ? { open: 'true' } : {}) },
      h('summary', {}, `${t(lang, 'trace_title')} · ${t(lang, 'trace_calls_line', { spark, sam, images, other })}`),
      h('div', { class: 'table-scroll' },
        h('table', { class: 'cmp' },
          h('tr', {}, h('th', {}, t(lang, 'trace_step')), h('th', {}, t(lang, 'trace_tool')), h('th', {}, t(lang, 'trace_io')), h('th', {}, t(lang, 'trace_dur')), h('th', {}, '')),
          ...traceRows,
        ),
      ),
    );
    sections.push(details);
    body.replaceChildren(...sections);
  })();

  return root;
}
