import { ApiError, api, bboxDiv, cropCanvas, fmtTime, h, msg, t, verdictBadge, type Bbox, type Lang } from './lib.js';
import { specLines } from './campaign.js';
import type { AdDetail } from './dto.js';

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img failed'));
    img.src = src;
  });
}

function fmtVal(lang: Lang, field: string, v: string): string {
  if (field === 'scope') {
    if (v === 'all') return t(lang, 'scope_all');
    if (v === 'selected_models') return t(lang, 'scope_selected');
    if (v === 'unspecified') return t(lang, 'scope_unspecified');
  }
  if (field === 'shipping') {
    if (v === 'free') return t(lang, 'ship_free');
    if (v === 'paid') return t(lang, 'ship_paid');
    if (v === 'unspecified') return t(lang, 'ship_unspecified');
  }
  return v;
}

function statusGlyph(status: string): { g: string; cls: string } {
  if (status === 'agree') return { g: '✓', cls: 'st-agree' };
  if (status === 'contradict') return { g: '✗', cls: 'st-contra' };
  return { g: '?', cls: 'st-unk' };
}

function quoteList(
  lang: Lang,
  imgSrc: string,
  items: Array<{ text: string; bbox: Bbox; scale: number; anchor: string }>,
): HTMLElement {
  const ul = h('ul', { class: 'quotes' });
  if (items.length === 0) {
    ul.append(h('li', { class: 'muted' }, t(lang, 'no_quote')));
    return ul;
  }
  for (const it of items.slice(0, 4)) {
    const li = h('li', { id: it.anchor }, h('blockquote', { dir: 'auto' }, it.text));
    ul.append(li);
    void loadImg(imgSrc)
      .then((img) => {
        const scaled: Bbox = {
          x: it.bbox.x * it.scale,
          y: it.bbox.y * it.scale,
          w: it.bbox.w * it.scale,
          h: it.bbox.h * it.scale,
        };
        // Clamp into the real pixels (model boxes can overshoot by a pixel).
        scaled.x = Math.max(0, Math.min(img.naturalWidth - 1, scaled.x));
        scaled.y = Math.max(0, Math.min(img.naturalHeight - 1, scaled.y));
        scaled.w = Math.min(img.naturalWidth - scaled.x, scaled.w);
        scaled.h = Math.min(img.naturalHeight - scaled.y, scaled.h);
        li.append(cropCanvas(img, scaled), h('div', { class: 'crop-cap' }, t(lang, 'quote_crop')));
      })
      .catch(() => {
        // The quote text stands on its own when the crop fails to load.
      });
  }
  return ul;
}

/** Ad image with panel/product/logo outlines. */
function adFigure(lang: Lang, id: number, d: AdDetail): HTMLElement {
  const frame = h('div', { class: 'img-frame' });
  const img = h('img', { src: `media/ad/${id}`, alt: d.snapshot.adKey }) as HTMLImageElement;
  frame.append(img);
  const add = (): void => {
    const W = img.naturalWidth || 1;
    const H = img.naturalHeight || 1;
    const c = d.adClaims;
    if (!c) return;
    if (c.panel) frame.append(bboxDiv(c.panel.bbox, W, H, 'panel', t(lang, 'legend_panel')));
    if (c.productBbox) frame.append(bboxDiv(c.productBbox, W, H, 'product', t(lang, 'legend_product')));
    if (c.logoBbox) frame.append(bboxDiv(c.logoBbox, W, H, 'logo', t(lang, 'legend_logo')));
  };
  if (img.complete && img.naturalWidth > 0) add();
  else img.addEventListener('load', add);
  return frame;
}

function pageFigure(lang: Lang, id: number, d: AdDetail): HTMLElement {
  const wrap = h('div', {});
  if (!d.pageClaims || d.pageClaims.shots === 0) {
    wrap.append(h('p', { class: 'muted' }, t(lang, 'explain_capture_failed')));
    return wrap;
  }
  const frame = h('div', { class: 'img-frame' });
  const img = h('img', { src: `media/pagecap/${id}?shot=0`, alt: d.snapshot.landingUrl }) as HTMLImageElement;
  frame.append(img);
  // Chunk bounds are 390-wide CSS px; the overlay uses percentages, so no
  // pixel size is needed.
  const byId = new Map(d.pageClaims.chunks.map((c) => [c.id, c]));
  const quoted = new Set<string>();
  for (const q of d.pageClaims.quotes) for (const cid of q.chunkIds) quoted.add(cid);
  for (const cid of quoted) {
    const c = byId.get(cid);
    if (c) frame.append(bboxDiv(c.bounds, 390, 844, 'chunk'));
  }
  wrap.append(frame);
  if (d.pageClaims.pageFile) {
    wrap.append(
      h('p', {}, h('a', { href: `pages/${d.pageClaims.pageFile}`, target: '_blank', rel: 'noopener' }, t(lang, 'open_live_page'))),
    );
  }
  return wrap;
}

function maskStage(lang: Lang, id: number): HTMLElement {
  const stage = h('div', { class: 'overlay-stage' });
  const img = h('img', { src: `media/after/${id}`, alt: t(lang, 'slider_after') }) as HTMLImageElement;
  const canvas = document.createElement('canvas');
  stage.append(img, canvas);
  void Promise.all([loadImg(`media/after/${id}`), loadImg(`media/mask-product/${id}`), loadImg(`media/mask-logo/${id}`)])
    .then(([base, product, logo]) => {
      canvas.width = base.naturalWidth;
      canvas.height = base.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // The mask PNGs are opaque grayscale (no alpha), so luminance becomes alpha.
      const tint = (m: HTMLImageElement, r: number, g: number, b: number): void => {
        const off = document.createElement('canvas');
        off.width = canvas.width;
        off.height = canvas.height;
        const octx = off.getContext('2d', { willReadFrequently: true });
        if (!octx) return;
        octx.drawImage(m, 0, 0, canvas.width, canvas.height);
        const d = octx.getImageData(0, 0, off.width, off.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const a = (d.data[i] as number) / 255;
          d.data[i] = r;
          d.data[i + 1] = g;
          d.data[i + 2] = b;
          d.data[i + 3] = Math.round(a * 140);
        }
        octx.putImageData(d, 0, 0);
        ctx.drawImage(off, 0, 0);
      };
      tint(product, 0, 179, 255);
      tint(logo, 255, 179, 0);
    })
    .catch(() => {
      stage.append(h('p', { class: 'muted' }, t(lang, 'err_unknown')));
    });
  const legend = h(
    'div',
    { class: 'legend' },
    h('span', {}, h('span', { class: 'sw', style: 'background:#00b3ff' }), t(lang, 'legend_product')),
    h('span', {}, h('span', { class: 'sw', style: 'background:#ffb300' }), t(lang, 'legend_logo')),
  );
  return h('div', {}, stage, legend);
}

function repairSection(lang: Lang, d: AdDetail): HTMLElement {
  const sec = h('section', {});
  const r = d.repair;
  if (!r) return sec;
  sec.append(h('h2', {}, t(lang, 'repair_title')));
  const id = d.snapshot.id;

  // Before/after slider.
  const slider = h('div', { class: 'slider' });
  const afterImg = h('img', { src: `media/after/${id}`, alt: t(lang, 'slider_after') }) as HTMLImageElement;
  const top = h('div', { class: 'top' }) as HTMLElement;
  const beforeImg = h('img', { src: `media/before/${id}`, alt: t(lang, 'slider_before') }) as HTMLImageElement;
  top.append(beforeImg);
  const range = h('input', {
    type: 'range', min: '0', max: '100', value: '50',
    'aria-label': t(lang, 'slider_hint'),
  }) as HTMLInputElement;
  const handle = h('div', { class: 'handle' }) as HTMLElement;
  const setSlider = (v: number): void => {
    range.value = String(v);
    top.style.width = `${v}%`;
    handle.style.left = `calc(${v}% - 1px)`;
  };
  range.addEventListener('input', () => setSlider(Number(range.value)));
  setSlider(50);
  slider.append(afterImg, top, handle, range);
  slider.append(h('span', { class: 'slider-tag before' }, t(lang, 'slider_before')));
  slider.append(h('span', { class: 'slider-tag after' }, t(lang, 'slider_after')));
  sec.append(h('div', { class: 'slider-wrap' }, slider));
  const showBefore = h('button', { class: 'btn secondary small', type: 'button' }, t(lang, 'view_before_btn')) as HTMLButtonElement;
  const showAfter = h('button', { class: 'btn secondary small', type: 'button' }, t(lang, 'view_after_btn')) as HTMLButtonElement;
  showBefore.addEventListener('click', () => setSlider(100));
  showAfter.addEventListener('click', () => setSlider(0));
  sec.append(h('div', { class: 'repair-controls' }, showBefore, showAfter));

  // Toggles: masks + heatmap.
  const extra = h('div', {});
  if (r.hasMasks) {
    const box = h('input', { type: 'checkbox', id: 'tgl-masks' }) as HTMLInputElement;
    const lab = h('label', { class: 'checkline', for: 'tgl-masks' }, box, t(lang, 'toggle_masks')) as HTMLElement;
    const holder = h('div', { hidden: 'true' });
    box.addEventListener('change', () => {
      holder.hidden = !box.checked;
      if (box.checked && holder.childElementCount === 0) holder.append(maskStage(lang, id));
    });
    sec.append(h('div', { class: 'repair-controls' }, lab));
    extra.append(holder);
  }
  if (r.hasDiff) {
    const box = h('input', { type: 'checkbox', id: 'tgl-diff' }) as HTMLInputElement;
    const lab = h('label', { class: 'checkline', for: 'tgl-diff' }, box, t(lang, 'toggle_diff')) as HTMLElement;
    const holder = h('div', { hidden: 'true' });
    box.addEventListener('change', () => {
      holder.hidden = !box.checked;
      if (box.checked && holder.childElementCount === 0) {
        holder.append(
          h('div', { class: 'overlay-stage' }, h('img', { src: `media/diff/${id}`, alt: t(lang, 'toggle_diff') })),
          h(
            'div',
            { class: 'legend' },
            h('span', {}, h('span', { class: 'sw', style: 'background:#ff00c8' }), t(lang, 'legend_changed')),
            h('span', {}, h('span', { class: 'sw', style: 'background:#00c86e' }), t(lang, 'legend_protected')),
          ),
        );
      }
    });
    sec.append(h('div', { class: 'repair-controls' }, lab));
    extra.append(holder);
  }
  sec.append(extra);

  // Proof numbers.
  const nums = h('div', { class: 'proof-nums' });
  const num = (value: string, ok: boolean, caption: string): HTMLElement =>
    h('div', { class: 'proof-num' }, h('div', { class: `v${ok ? ' ok' : ' bad'}`, dir: 'ltr' }, value), h('div', { class: 'k' }, caption));
  nums.append(
    num(
      String(r.proof.changed_inside_protected),
      r.proof.changed_inside_protected === 0,
      t(lang, 'proof_protected', { count: r.proof.changed_inside_protected }),
    ),
    num(
      String(r.proof.changed_outside_rect),
      r.proof.changed_outside_rect === 0,
      t(lang, 'proof_outside', { count: r.proof.changed_outside_rect }),
    ),
    num(
      r.revalidation.pass ? t(lang, 'word_pass') : t(lang, 'word_fail'),
      r.revalidation.pass,
      t(lang, 'proof_reval', { result: r.revalidation.pass ? t(lang, 'word_pass') : t(lang, 'word_fail') }),
    ),
  );
  sec.append(nums);
  if (r.revalidation.claims) {
    const fc = r.revalidation.claims;
    sec.append(
      h('p', { dir: 'auto' }, t(lang, 'reval_extracted', {
        percent: fc.percent === null ? '—' : `${fc.percent}%`,
        scope: fmtVal(lang, 'scope', fc.scope),
        shipping: fmtVal(lang, 'shipping', fc.shipping),
        valid: fc.valid ?? '—',
      })),
    );
  }
  const checks = h('ul', { class: 'about-list' });
  for (const c of r.revalidation.checks) {
    checks.append(
      h('li', {}, h('span', { class: 'mono', dir: 'ltr' }, `${c.check}: ${c.pass ? 'PASS' : 'FAIL'} — ${c.detail}`)),
    );
  }
  sec.append(
    h('div', { class: 'digest' }, `${t(lang, 'proof_digest')}: `, h('span', { class: 'mono', dir: 'ltr' }, r.digest)),
    h('div', { class: 'digest' }, `${t(lang, 'proof_spec_version')}: `, h('span', { dir: 'ltr' }, String(r.specVersion))),
    h('details', { class: 'card trace-box' }, h('summary', {}, t(lang, 'proof_reval', { result: '' }).replace(/:\s*$/, '')), checks),
  );

  const dl = h('a', { class: 'btn secondary small', href: `media/after/${id}`, download: 'after.png' }, t(lang, 'btn_download_after'));
  const paused = h(
    'button',
    { class: 'btn small', type: 'button', disabled: 'true', title: t(lang, 'tip_owner_only') },
    t(lang, 'btn_create_paused'),
  );
  sec.append(
    h('div', { class: 'repair-actions' }, dl, paused),
    h('p', { class: 'muted' }, t(lang, 'note_recompress')),
  );
  return sec;
}

function traceSection(lang: Lang, d: AdDetail): HTMLElement {
  let spark = 0;
  let sam = 0;
  let other = 0;
  for (const e of d.trace) {
    if (e.tool.startsWith('model:muse-spark')) spark += 1;
    else if (e.tool.startsWith('model:sam')) sam += 1;
    else other += 1;
  }
  const table = h('table', { class: 'trace' });
  const thead = h('tr', {},
    h('th', {}, t(lang, 'trace_step')),
    h('th', {}, t(lang, 'trace_tool')),
    h('th', {}, t(lang, 'trace_io')),
    h('th', {}, t(lang, 'trace_dur')),
    h('th', {}, t(lang, 'trace_next')),
  );
  table.append(h('thead', {}, thead));
  const tb = h('tbody', {});
  for (const e of d.trace) {
    const io = h('td', { class: 'io' });
    io.append(h('div', { dir: 'auto' }, e.input), h('div', { dir: 'auto' }, `→ ${e.output}`));
    if (e.evidence.length > 0) {
      const ev = h('div', {});
      for (const id of e.evidence) {
        const mq = id.match(/^page:quote:(\d+)$/);
        const ma = id.match(/^ad:offer_text:(\d+)$/);
        const anchor = mq ? `#pq-${mq[1]}` : ma ? `#ao-${ma[1]}` : null;
        ev.append(
          anchor
            ? h('a', { class: 'pill', href: anchor, dir: 'ltr' }, id)
            : h('span', { class: 'pill', dir: 'ltr' }, id),
          ' ',
        );
      }
      io.append(ev);
    }
    tb.append(
      h('tr', {},
        h('td', { dir: 'ltr' }, `${e.seq}. ${e.step}`),
        h('td', {}, h('span', { class: 'mono', dir: 'ltr' }, e.tool), ' ', h('span', { class: `pill${e.cached ? '' : ' live'}` }, e.cached ? t(lang, 'trace_cached') : t(lang, 'trace_live'))),
        io,
        h('td', { dir: 'ltr' }, `${e.durationMs} ms`),
        h('td', { dir: 'ltr' }, e.next),
      ),
    );
  }
  table.append(tb);
  const det = h('details', { class: 'card trace-box', id: 'trace' },
    h('summary', {}, t(lang, 'trace_title')),
    h('p', { class: 'trace-calls' }, t(lang, 'trace_calls_line', { spark, sam, other })),
    h('div', { class: 'table-scroll', style: 'border:0' }, table),
  );
  return det;
}

export function detailView(lang: Lang, id: number, cachedHint: boolean): HTMLElement {
  const root = h('div', {});
  root.append(h('p', { class: 'muted' }, '…'));
  void (async () => {
    let d: AdDetail;
    try {
      d = (await api(`api/ads/${id}`)) as AdDetail;
    } catch (e) {
      const key = e instanceof ApiError ? e.key : 'err_unknown';
      root.replaceChildren(h('p', {}, h('a', { class: 'back', href: '#/' }, t(lang, 'back_to_campaign'))), h('p', { class: 'form-error' }, t(lang, key as Parameters<typeof t>[1])));
      return;
    }
    root.replaceChildren();
    const arrow = lang === 'he' ? '›' : '‹';
    root.append(h('p', {}, h('a', { class: 'back', href: '#/' }, `${arrow} ${t(lang, 'back_to_campaign')}`)));
    if (cachedHint) root.append(h('p', { class: 'card' }, t(lang, 'check_result_cached')));
    root.append(
      h('div', { class: 'verdict-banner' },
        h('div', {}, verdictBadge(lang, d.snapshot.verdict)),
        h('div', {},
          h('div', {},
            h('span', { class: 'chip', dir: 'ltr' }, d.snapshot.adKey),
            ' ',
            h('span', { class: `chip${d.snapshot.cached ? '' : ' fresh'}` },
              d.snapshot.cached
                ? t(lang, 'run_saved', { time: fmtTime(lang, d.snapshot.captureTime) })
                : t(lang, 'run_fresh')),
          ),
          h('p', { dir: 'auto' }, msg(lang, d.explain)),
        ),
      ),
    );

    // Evidence columns.
    const specCol = h('div', { class: 'card ev-col' },
      h('h3', {}, t(lang, 'col_spec')),
      h('ul', { class: 'spec-list' }, ...specLines(lang, d.spec).map((s) => h('li', {}, s))),
      h('p', {}, h('span', { class: 'chip', dir: 'ltr' }, t(lang, 'spec_version', { version: d.spec.version }))),
    );
    const adCol = h('div', { class: 'card ev-col' }, h('h3', {}, t(lang, 'col_ad')));
    if (d.adClaims) {
      adCol.append(adFigure(lang, id, d));
      const items = d.adClaims.offerTexts
        .filter((o) => o.text.trim() !== '')
        .map((o, i) => ({ text: o.text, bbox: o.bbox, scale: 1, anchor: `ao-${i}` }));
      adCol.append(quoteList(lang, `media/ad/${id}`, items));
      if (d.snapshot.copy.trim() !== '') {
        adCol.append(h('p', { class: 'muted', dir: 'auto' }, d.snapshot.copy));
      }
    }
    const pageCol = h('div', { class: 'card ev-col' }, h('h3', {}, t(lang, 'col_page')));
    pageCol.append(pageFigure(lang, id, d));
    if (d.pageClaims) {
      const byId = new Map(d.pageClaims.chunks.map((c) => [c.id, c]));
      const items = d.pageClaims.quotes
        .map((q, i) => {
          const c = q.chunkIds.map((cid) => byId.get(cid)).find((c) => c !== undefined);
          return c ? { text: q.text, bbox: c.bounds, scale: 2, anchor: `pq-${i}` } : null;
        })
        .filter((x): x is { text: string; bbox: Bbox; scale: number; anchor: string } => x !== null);
      pageCol.append(quoteList(lang, `media/pagecap/${id}?shot=0`, items));
    }
    root.append(h('div', { class: 'evidence' }, specCol, adCol, pageCol));

    // Comparison table.
    if (d.comparisons.length > 0) {
      const table = h('table', { class: 'cmp' });
      table.append(
        h('thead', {}, h('tr', {},
          h('th', {}, t(lang, 'th_field')),
          h('th', {}, t(lang, 'th_spec')),
          h('th', {}, t(lang, 'th_ad')),
          h('th', {}, t(lang, 'th_page')),
        )),
      );
      const tb = h('tbody', {});
      for (const c of d.comparisons) {
        const fieldKey = `field_${c.field === 'valid_until' ? 'valid_until' : c.field}` as Parameters<typeof t>[1];
        const sa = statusGlyph(c.ad);
        const sp = statusGlyph(c.page);
        tb.append(h('tr', {},
          h('td', {}, t(lang, fieldKey)),
          h('td', { dir: 'auto' }, fmtVal(lang, c.field, c.spec)),
          h('td', {}, h('span', { class: `st ${sa.cls}` }, sa.g), ' ', h('span', { dir: 'auto' }, fmtVal(lang, c.field, c.adObserved))),
          h('td', {}, h('span', { class: `st ${sp.cls}` }, sp.g), ' ', h('span', { dir: 'auto' }, fmtVal(lang, c.field, c.pageObserved))),
        ));
      }
      table.append(tb);
      root.append(h('h2', {}, t(lang, 'cmp_title')), h('div', { class: 'table-scroll' }, table));
    }

    // Verdict-specific sections.
    const v = d.snapshot.verdict;
    if (v === 'AD_WRONG_REPAIRABLE' && d.repair) root.append(repairSection(lang, d));
    if (v === 'AD_WRONG_UNSAFE' && d.refusal) {
      const sec = h('section', {}, h('h2', {}, t(lang, 'refuse_title')));
      const ul = h('ul', { class: 'about-list' });
      for (const b of d.refusal.blockers) ul.append(h('li', { dir: 'auto' }, msg(lang, b)));
      sec.append(h('div', { class: 'card' }, ul));
      if (d.adClaims?.panel) {
        sec.append(h('div', { class: 'card', style: 'margin-top:12px' }, adFigure(lang, id, d)));
        if (d.refusal.blockers.some((b) => b.key === 'blocker_panel_overlaps_protected')) {
          sec.append(h('p', { class: 'muted' }, t(lang, 'refuse_overlap_note')));
        }
      }
      root.append(sec);
    }
    if (v === 'PAGE_WRONG') {
      root.append(h('section', {}, h('div', { class: 'card question-card' }, t(lang, 'pagewrong_injected_note'))));
    }
    if (v === 'AMBIGUOUS' && d.question) {
      root.append(h('section', {}, h('h2', {}, t(lang, 'ambiguous_title')), h('div', { class: 'card question-card', dir: 'auto' }, msg(lang, d.question))));
    }
    root.append(traceSection(lang, d));
  })();
  return root;
}
