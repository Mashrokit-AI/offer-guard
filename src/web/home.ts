import { api, errText, fmtTime, h, modeBadge, qaBadge, t, type Lang } from './lib.js';
import type { BrandDto, JobDto, OutputCardDto, PresetDto } from './dto.js';

interface JobRowEvent {
  outputId: number;
  sourceId: string;
  sourceIndex: number;
  preset: string;
  status: string;
  retries: number;
  error?: string;
}

function presetLabel(presets: PresetDto[], id: string): string {
  const p = presets.find((x) => x.id === id);
  return p ? `${p.label} · ${p.width}×${p.height}` : id;
}

function outputCard(lang: Lang, presets: PresetDto[], o: OutputCardDto): HTMLElement {
  const card = h('a', { class: 'ad-card', href: `#/output/${o.id}` });
  const img = h('img', { class: 'thumb', src: o.image, alt: presetLabel(presets, o.preset), loading: 'lazy' }) as HTMLImageElement;
  const badges = h('div', { class: 'card-badges' }, qaBadge(lang, o.qaPass), modeBadge(lang, o.mode));
  if (o.retries > 0) badges.append(h('span', { class: 'chip' }, t(lang, 'qa_retry')));
  const proof = o.proofDiff !== null ? h('div', { class: 'ad-card-meta' }, h('span', {}, t(lang, 'card_proof', { count: o.proofDiff, what: '✓' }))) : null;
  card.append(
    img,
    h('div', { class: 'ad-card-body' }, h('div', { class: 'ad-card-reason' }, presetLabel(presets, o.preset)), badges, proof),
  );
  return card;
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
  const brandSel = h('select', { id: 'brand', class: 'input' }) as HTMLSelectElement;
  brandSel.addEventListener('change', () => {
    state.brandId = brandSel.value;
  });
  const matchNote = h('div', { class: 'muted small' });
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
      const b = h('button', { type: 'button', class: `chipbtn${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false' }, `${p.label} · ${p.width}×${p.height}`) as HTMLButtonElement;
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
  const jobBanner = h('div', { class: 'job-banner', hidden: 'true' });
  const grid = h('div', { class: 'grid' });
  const runBar = h('div', { class: 'toolbar', hidden: 'true' });
  const updateGenerate = (): void => {
    genBtn.disabled = state.running || state.files.length === 0 || state.sizes.size === 0;
  };

  const renderRun = async (jobId: string): Promise<void> => {
    try {
      const run = (await api(`api/runs/${encodeURIComponent(jobId)}`)) as JobDto;
      grid.replaceChildren();
      for (const o of run.outputs) grid.append(outputCard(lang, state.presets, o));
      runBar.replaceChildren();
      runBar.hidden = false;
      const dl = h('a', { class: 'btn secondary small', href: `api/runs/${encodeURIComponent(jobId)}/zip` }, t(lang, 'btn_download_all')) as HTMLAnchorElement;
      runBar.append(dl, h('span', { class: 'run-caption' }, `✓ ${run.outputs.filter((o) => o.status === 'pass').length} · ⚠ ${run.outputs.filter((o) => o.status === 'needs_review').length}`));
    } catch {
      // The grid keeps whatever progress rows already landed.
    }
  };

  const followJob = (key: string, storeJobId: string, total: number): void => {
    state.running = true;
    updateGenerate();
    jobBanner.hidden = false;
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
          const card = outputCard(lang, state.presets, {
            id: e.row.outputId, sourceId: e.row.sourceId, sourceIndex: e.row.sourceIndex,
            preset: e.row.preset, mode: state.mode, status: e.row.status,
            image: `media/output/${e.row.outputId}`, qaPass: e.row.status === 'pass' ? true : e.row.status === 'needs_review' ? false : null,
            retries: e.row.retries, proofDiff: null,
          });
          grid.append(card);
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
      grid.replaceChildren();
      runBar.hidden = true;
      followJob(res.key, res.jobId, state.files.length * state.sizes.size);
    } catch (e) {
      jobBanner.hidden = false;
      jobBanner.replaceChildren(h('strong', {}, errText(lang, e)));
    }
  });

  // --- demo ---
  const demoSec = h('section', { class: 'card', style: 'margin-top:18px' });
  const demoGrid = h('div', { class: 'grid' });

  const form = h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', {}, t(lang, 'drop_title')), drop, fileInput),
    h('div', { class: 'formrow' },
      h('div', { class: 'field' }, h('label', { for: 'brand' }, t(lang, 'brand_label')), brandSel, matchNote),
      h('div', { class: 'field' }, h('label', {}, t(lang, 'mode_label')), h('div', { class: 'seg' }, modeProt, modeFast)),
    ),
    h('div', { class: 'field' }, h('label', {}, t(lang, 'sizes_label')), h('div', { class: 'toolbar', style: 'margin:0 0 8px' }, allMetaBtn), chips),
    h('div', { class: 'toolbar' }, genBtn),
  );
  root.append(form, jobBanner, runBar, grid, demoSec);

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
      form.append(h('p', { class: 'muted' }, errText(lang, new Error('load'))));
    }
    try {
      const demo = (await api('api/demo')) as JobDto;
      demoSec.replaceChildren(
        h('h2', { style: 'margin-top:0' }, t(lang, 'btn_demo')),
        h('p', { class: 'muted', style: 'margin-top:0' }, t(lang, 'demo_saved', { time: fmtTime(lang, demo.finishedAt ?? demo.createdAt) })),
        demoGrid,
        h('div', { class: 'toolbar' }, (() => {
          const b = h('button', { type: 'button', class: 'btn secondary' }, t(lang, 'btn_demo_live')) as HTMLButtonElement;
          b.addEventListener('click', async () => {
            const fd = new FormData();
            fd.append('demoSource', 'gali-he');
            fd.append('sizes', demo.sizes.join(','));
            fd.append('mode', demo.mode);
            if (demo.brandId) fd.append('brandId', demo.brandId);
            try {
              const res = (await api('api/jobs', { method: 'POST', body: fd })) as { key: string; jobId: string };
              grid.replaceChildren();
              followJob(res.key, res.jobId, demo.sizes.length);
              window.scrollTo(0, 0);
            } catch (e) {
              jobBanner.hidden = false;
              jobBanner.replaceChildren(h('strong', {}, errText(lang, e)));
            }
          });
          return b;
        })()),
      );
      demoGrid.replaceChildren();
      for (const o of demo.outputs) demoGrid.append(outputCard(lang, state.presets, o));
    } catch {
      demoSec.hidden = true;
    }
  })();

  return root;
}
