import { api, dims, errText, fmtTime, groupByOrientation, h, modeBadge, modelFooter, presetName, qaBadge, t, type Lang, type Orientation } from './lib.js';
import { PRESETS } from '../shared/presets.js';
import type { BrandDto, JobDto, OutputCardDto, PresetDto } from './dto.js';

interface JobRowEvent {
  outputId: number;
  sourceId: string;
  sourceIndex: number;
  preset: string;
  status: string;
  retries: number;
  models: string[];
  traceMs: number;
  error?: string;
}

function presetLabel(lang: Lang, presets: PresetDto[], id: string): string {
  const p = presets.find((x) => x.id === id);
  return p ? `${presetName(lang, p.id, p.label)} · ${dims(p.width, p.height)}` : id;
}

function groupTitle(lang: Lang, key: Orientation): string {
  return t(lang, key === 'square' ? 'group_square' : key === 'landscape' ? 'group_landscape' : 'group_vertical');
}

/**
 * Output card: the image always renders at its true aspect ratio (never
 * cropped) inside a preset-ratio frame on a neutral checkerboard. Failed
 * cells render a text placeholder instead of a broken image.
 */
function outputCard(lang: Lang, presets: PresetDto[], o: OutputCardDto): HTMLElement {
  const card = h('a', { class: 'ad-card', href: `#/output/${o.id}` });
  const frame = h('div', { class: 'thumb-frame' });
  if (o.status === 'failed') {
    frame.append(h('span', { class: 'thumb-failed' }, `✕ ${t(lang, 'job_failed')}`));
  } else {
    const p = presets.find((x) => x.id === o.preset);
    if (p) frame.setAttribute('style', `aspect-ratio:${p.width}/${p.height}`);
    frame.append(h('img', { src: o.image, alt: presetLabel(lang, presets, o.preset), loading: 'lazy' }) as HTMLImageElement);
  }
  const badges = h('div', { class: 'card-badges' }, qaBadge(lang, o.qaPass), modeBadge(lang, o.mode));
  // The retry badge means the retry FIXED it; a still-failing output shows only qa_fail.
  if (o.retries > 0 && o.qaPass === true) badges.append(h('span', { class: 'chip fresh' }, t(lang, 'qa_retry')));
  const proof = o.proofDiff !== null ? h('div', { class: 'ad-card-meta' }, h('span', {}, t(lang, 'card_proof', { count: o.proofDiff }))) : null;
  card.append(
    frame,
    h('div', { class: 'ad-card-body' }, h('div', { class: 'ad-card-reason' }, presetLabel(lang, presets, o.preset)), badges, proof, modelFooter(o.models ?? [], o.traceMs ?? 0)),
  );
  return card;
}

/** Card grid grouped by orientation (square/portrait, landscape, vertical). */
function groupedGrid(lang: Lang, presets: PresetDto[], outputs: OutputCardDto[]): HTMLElement {
  const wrap = h('div', {});
  for (const g of groupByOrientation(presets, outputs, (o) => o.preset)) {
    const grid = h('div', { class: `grid cols-${g.key}` });
    for (const o of g.items) grid.append(outputCard(lang, presets, o));
    wrap.append(h('h3', { class: 'group-title' }, groupTitle(lang, g.key)), grid);
  }
  return wrap;
}

export function homeView(lang: Lang): HTMLElement {
  const root = h('div', {});
  root.append(h('h1', {}, t(lang, 'home_title')), h('p', { class: 'sub' }, t(lang, 'home_sub')));

  const state = {
    files: [] as File[],
    brandId: '' as string,
    sizes: new Set<string>(),
    mode: 'protected' as string,
    presets: [] as PresetDto[],
    brands: [] as BrandDto[],
    running: false,
  };

  // --- upload ---
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: 'true', hidden: 'true' }) as HTMLInputElement;
  const thumbs = h('div', { class: 'thumbs' });
  const drop = h('div', { class: 'drop', tabindex: '0', role: 'button' }, h('div', { class: 'drop-title' }, t(lang, 'drop_title')), h('div', { class: 'muted' }, t(lang, 'drop_hint')), thumbs);
  const refreshThumbs = (): void => {
    thumbs.replaceChildren();
    for (const f of state.files) {
      const url = URL.createObjectURL(f);
      const img = h('img', { src: url, alt: f.name }) as HTMLImageElement;
      img.onload = () => URL.revokeObjectURL(url);
      thumbs.append(img);
    }
  };
  const addFiles = (list: FileList | File[]): void => {
    for (const f of Array.from(list)) {
      if (state.files.length >= 3) break;
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) continue;
      state.files.push(f);
    }
    refreshThumbs();
    updateGenerate();
    if (state.files.length > 0 && !state.brandId) void autoMatch(state.files[0] as File);
  };
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files) addFiles(fileInput.files);
    fileInput.value = '';
  });

  // --- brand ---
  // Placeholder option on first render: the select keeps its height when brands load.
  const brandSel = h('select', { id: 'brand', class: 'input' }, h('option', { value: '' }, t(lang, 'brand_none'))) as HTMLSelectElement;
  brandSel.addEventListener('change', () => {
    state.brandId = brandSel.value;
  });
  const matchNote = h('div', { class: 'muted small match-note' });
  const autoMatch = async (f: File): Promise<void> => {
    try {
      const fd = new FormData();
      fd.append('image', f);
      const res = (await api('api/match', { method: 'POST', body: fd })) as { brandId: string | null; reason: string };
      if (res.brandId && !state.brandId) {
        state.brandId = res.brandId;
        brandSel.value = res.brandId;
        const b = state.brands.find((x) => x.id === res.brandId);
        matchNote.textContent = t(lang, 'brand_auto', { name: b?.name ?? res.brandId });
      }
    } catch {
      // Auto-match is a nicety; the user can always pick by hand.
    }
  };

  // --- sizes ---
  const chips = h('div', { class: 'chips' });
  const allMetaBtn = h('button', { type: 'button', class: 'btn secondary small' }, t(lang, 'sizes_all_meta')) as HTMLButtonElement;
  allMetaBtn.addEventListener('click', () => {
    state.sizes = new Set(state.presets.filter((p) => p.meta).map((p) => p.id));
    paintChips();
    updateGenerate();
  });
  const paintChips = (): void => {
    chips.replaceChildren();
    for (const p of state.presets) {
      const on = state.sizes.has(p.id);
      const b = h('button', { type: 'button', class: `chipbtn${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false' }, `${presetName(lang, p.id, p.label)} · ${dims(p.width, p.height)}`) as HTMLButtonElement;
      b.addEventListener('click', () => {
        if (state.sizes.has(p.id)) state.sizes.delete(p.id);
        else if (state.sizes.size < 8) state.sizes.add(p.id);
        paintChips();
        updateGenerate();
      });
      chips.append(b);
    }
  };

  // --- mode ---
  const modeProt = h('button', { type: 'button', 'aria-pressed': 'true', title: t(lang, 'mode_protected_tip') }, t(lang, 'mode_protected')) as HTMLButtonElement;
  const modeFast = h('button', { type: 'button', 'aria-pressed': 'false', title: t(lang, 'mode_fast_tip') }, t(lang, 'mode_fast')) as HTMLButtonElement;
  const setMode = (m: string): void => {
    state.mode = m;
    modeProt.setAttribute('aria-pressed', m === 'protected' ? 'true' : 'false');
    modeFast.setAttribute('aria-pressed', m === 'fast' ? 'true' : 'false');
  };
  modeProt.addEventListener('click', () => setMode('protected'));
  modeFast.addEventListener('click', () => setMode('fast'));

  // --- generate ---
  const genBtn = h('button', { type: 'button', class: 'btn', disabled: 'true' }, t(lang, 'btn_generate')) as HTMLButtonElement;
  const genHint = h('span', { class: 'gen-hint' });
  const jobBanner = h('div', { class: 'job-banner', hidden: 'true' });
  const liveWrap = h('div', {});
  const runBar = h('div', { class: 'toolbar', hidden: 'true' });
  const updateGenerate = (): void => {
    genBtn.disabled = state.running || state.files.length === 0 || state.sizes.size === 0;
    const hint = state.files.length === 0 ? t(lang, 'gen_need_image') : state.sizes.size === 0 ? t(lang, 'gen_need_size') : '';
    genHint.textContent = hint;
    if (hint) genBtn.setAttribute('title', hint);
    else genBtn.removeAttribute('title');
  };

  /** Cards landed so far in the running job (re-rendered grouped per size). */
  let liveRows: OutputCardDto[] = [];
  const renderLive = (): void => {
    liveWrap.replaceChildren(groupedGrid(lang, state.presets, liveRows));
  };

  const renderRun = async (jobId: string): Promise<void> => {
    try {
      const run = (await api(`api/runs/${encodeURIComponent(jobId)}`)) as JobDto;
      liveRows = run.outputs;
      renderLive();
      runBar.replaceChildren();
      runBar.hidden = false;
      const dl = h('a', { class: 'btn secondary small', href: `api/runs/${encodeURIComponent(jobId)}/zip` }, t(lang, 'btn_download_all')) as HTMLAnchorElement;
      const fails = run.outputs.filter((o) => o.status === 'failed').length;
      const caption = `✓ ${run.outputs.filter((o) => o.status === 'pass').length} · ⚠ ${run.outputs.filter((o) => o.status === 'needs_review').length}${fails > 0 ? ` · ✕ ${fails}` : ''}`;
      runBar.append(dl, h('span', { class: 'run-caption' }, caption));
    } catch {
      // The grid keeps whatever progress rows already landed.
    }
  };

  const followJob = (key: string, storeJobId: string, total: number): void => {
    state.running = true;
    updateGenerate();
    jobBanner.hidden = false;
    // Live results land directly under the form; bring them into view on start.
    liveWrap.scrollIntoView({ block: 'nearest' });
    const bar = h('div', {});
    const label = h('strong', {}, t(lang, 'btn_generating', { done: 0, total }));
    jobBanner.replaceChildren(label, h('div', { class: 'progress' }, bar));
    const es = new EventSource(`api/live/${encodeURIComponent(key)}/events`);
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data as string) as { type: string; done: number; total: number; row?: JobRowEvent };
        if (e.type === 'progress' && e.row) {
          label.textContent = t(lang, 'btn_generating', { done: e.done, total: e.total });
          bar.style.width = `${Math.round((e.done / Math.max(1, e.total)) * 100)}%`;
          liveRows = [...liveRows, {
            id: e.row.outputId, sourceId: e.row.sourceId, sourceIndex: e.row.sourceIndex,
            preset: e.row.preset, mode: state.mode, status: e.row.status,
            image: `media/output/${e.row.outputId}`, qaPass: e.row.status === 'pass' ? true : e.row.status === 'needs_review' ? false : null,
            retries: e.row.retries, proofDiff: null, models: e.row.models ?? [], traceMs: e.row.traceMs ?? 0,
          }];
          renderLive();
        } else if (e.type === 'done' || e.type === 'failed') {
          es.close();
          state.running = false;
          jobBanner.hidden = true;
          updateGenerate();
          void renderRun(storeJobId);
        }
      } catch {
        // A malformed SSE frame never breaks the page.
      }
    };
    es.onerror = () => {
      es.close();
      if (state.running) {
        state.running = false;
        jobBanner.hidden = true;
        updateGenerate();
        void renderRun(storeJobId);
      }
    };
  };

  genBtn.addEventListener('click', async () => {
    if (state.running || state.files.length === 0 || state.sizes.size === 0) return;
    const fd = new FormData();
    // Distinct field names: multipart parsers keep one file per name.
    state.files.forEach((f, i) => fd.append(`source${i}`, f));
    fd.append('sizes', [...state.sizes].join(','));
    fd.append('mode', state.mode);
    if (state.brandId) fd.append('brandId', state.brandId);
    try {
      const res = (await api('api/jobs', { method: 'POST', body: fd })) as { key: string; jobId: string };
      liveRows = [];
      renderLive();
      runBar.hidden = true;
      followJob(res.key, res.jobId, state.files.length * state.sizes.size);
    } catch (e) {
      jobBanner.hidden = false;
      jobBanner.replaceChildren(h('strong', {}, errText(lang, e)));
    }
  });

  // --- demo (last on the page; unstyled until it loads so no empty card flashes) ---
  const demoSec = h('section', { class: 'demo-sec', id: 'demo' });

  // --- Meta models row ---
  const modelChip = (name: string, descKey: 'models_sam' | 'models_image' | 'models_spark', anchor: string): HTMLElement =>
    h('a', { class: 'model-chip', href: `#/about/${anchor}` }, h('b', { dir: 'ltr' }, name), h('span', {}, ` — ${t(lang, descKey)}`));
  const modelsRow = h('section', { class: 'card models-row' },
    h('strong', { class: 'models-title' }, t(lang, 'models_title')),
    h('div', { class: 'models-chips' },
      modelChip('SAM 3.1', 'models_sam', 'about-step2'),
      modelChip('Muse Image', 'models_image', 'about-step3'),
      modelChip('Muse Spark 1.3', 'models_spark', 'about-step1'),
    ),
  );

  const demoBtn = h('button', { type: 'button', class: 'btn secondary small' }, t(lang, 'btn_demo')) as HTMLButtonElement;
  demoBtn.addEventListener('click', () => demoSec.scrollIntoView());
  const form = h('div', { class: 'card', id: 'try-form' },
    h('h2', { class: 'try-title' }, t(lang, 'try_title')),
    h('div', { class: 'field' }, drop, fileInput),
    h('div', { class: 'formrow' },
      h('div', { class: 'field' }, h('label', { for: 'brand' }, t(lang, 'brand_label')), brandSel, matchNote),
      h('div', { class: 'field' }, h('label', {}, t(lang, 'mode_label')), h('div', { class: 'seg' }, modeProt, modeFast)),
    ),
    h('div', { class: 'field' }, h('label', {}, t(lang, 'sizes_label')), h('div', { class: 'toolbar', style: 'margin:0 0 8px' }, allMetaBtn), chips),
    h('div', { class: 'toolbar' }, genBtn, demoBtn, genHint),
  );
  // Size chips render synchronously from the same static preset table the
  // server returns, so the form's first paint is already its final height —
  // the /api/brands reconcile below replaces identical chips (zero motion).
  state.presets = [...PRESETS];
  paintChips();
  updateGenerate();
  // Order: form → live run → models → saved demo. Everything async lands at or
  // below the form, so nothing above the form ever changes height.
  root.append(form, jobBanner, runBar, liveWrap, modelsRow, demoSec);

  // --- load brands/presets/demo ---
  void (async () => {
    try {
      const data = (await api('api/brands')) as { presets: PresetDto[]; brands: BrandDto[] };
      state.presets = data.presets;
      state.brands = data.brands;
      brandSel.replaceChildren(h('option', { value: '' }, t(lang, 'brand_none')));
      for (const b of data.brands) brandSel.append(h('option', { value: b.id }, b.demo ? `${b.name} ★` : b.name));
      paintChips();
      updateGenerate();
    } catch {
      // Brands unknown: drop back to the empty form plus the error note.
      state.presets = [];
      state.sizes.clear();
      paintChips();
      updateGenerate();
      form.append(h('p', { class: 'muted' }, errText(lang, new Error('load'))));
    }
    try {
      const demo = (await api('api/demo')) as JobDto;
      // The saved demo shows only passed outputs (plus the one Auto-fixed card,
      // which proves the QA loop); anything else never ships in the fixture.
      const passed = demo.outputs.filter((o) => o.qaPass === true);
      const demoBody = h('div', {});
      demoBody.append(groupedGrid(lang, state.presets, passed));
      // Source leads the first group row (source → outputs); wraps on narrow.
      const firstSource = demo.sources[0];
      if (firstSource) {
        const srcCard = h('div', { class: 'ad-card source-card' },
          h('div', { class: 'thumb-frame natural' }, h('img', { src: `media/source/${firstSource}`, alt: t(lang, 'detail_before') }) as HTMLImageElement),
          h('div', { class: 'ad-card-body' }, h('div', { class: 'ad-card-reason' }, t(lang, 'detail_before'))),
        );
        const firstGrid = demoBody.querySelector('.grid');
        if (firstGrid) firstGrid.prepend(srcCard);
        else demoBody.prepend(srcCard);
      }
      const liveBtn = h('button', { type: 'button', class: 'btn secondary' }, t(lang, 'btn_demo_live')) as HTMLButtonElement;
      liveBtn.addEventListener('click', async () => {
        const fd = new FormData();
        fd.append('demoSource', 'gali-he');
        // The demo holds one bonus output (fast li-post); sizes stay unique.
        const sizes = [...new Set(demo.sizes)];
        fd.append('sizes', sizes.join(','));
        fd.append('mode', demo.mode);
        if (demo.brandId) fd.append('brandId', demo.brandId);
        try {
          const res = (await api('api/jobs', { method: 'POST', body: fd })) as { key: string; jobId: string };
          liveRows = [];
          renderLive();
          followJob(res.key, res.jobId, sizes.length);
        } catch (e) {
          jobBanner.hidden = false;
          jobBanner.replaceChildren(h('strong', {}, errText(lang, e)));
          jobBanner.scrollIntoView({ block: 'nearest' });
        }
      });
      demoSec.classList.add('card');
      demoSec.replaceChildren(
        h('h2', { style: 'margin-top:0' }, t(lang, 'btn_demo')),
        h('p', { class: 'muted', style: 'margin-top:0' }, t(lang, 'demo_saved', { time: fmtTime(lang, demo.finishedAt ?? demo.createdAt) })),
        demoBody,
        h('div', { class: 'toolbar' }, liveBtn),
      );
    } catch {
      demoSec.hidden = true;
    }
  })();

  return root;
}
