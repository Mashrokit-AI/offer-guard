import { api, dims, errText, h, presetName, t, type Lang } from './lib.js';
import type { BrandDto, NormBoxDto, PresetDto, TemplateDto, TemplateSpecDto } from './dto.js';

interface Zone {
  key: string;
  label: string;
  cls: string;
  get: () => NormBoxDto | null;
  set: (b: NormBoxDto) => void;
}

function zonesOf(lang: Lang, spec: TemplateSpecDto): Zone[] {
  const z: Zone[] = [];
  if (spec.logo) z.push({ key: 'logo', label: t(lang, 'legend_logo'), cls: 'logo', get: () => spec.logo?.box ?? null, set: (b) => { if (spec.logo) spec.logo.box = b; } });
  if (spec.product_zone) z.push({ key: 'product', label: t(lang, 'legend_product'), cls: 'product', get: () => spec.product_zone, set: (b) => { spec.product_zone = b; } });
  if (spec.headline_zone) z.push({ key: 'headline', label: t(lang, 'legend_headline'), cls: 'headline', get: () => spec.headline_zone, set: (b) => { spec.headline_zone = b; } });
  if (spec.subtext_zone) z.push({ key: 'subtext', label: t(lang, 'legend_subtext'), cls: 'subtext', get: () => spec.subtext_zone, set: (b) => { spec.subtext_zone = b; } });
  if (spec.panel_zone) z.push({ key: 'panel', label: t(lang, 'legend_panel'), cls: 'panel', get: () => spec.panel_zone?.box ?? null, set: (b) => { if (spec.panel_zone) spec.panel_zone.box = b; } });
  spec.frames.forEach((f, i) => {
    z.push({ key: `frame${i}`, label: f.kind, cls: 'frame', get: () => spec.frames[i]?.box ?? null, set: (b) => { const fr = spec.frames[i]; if (fr) fr.box = b; } });
  });
  return z;
}

/** Template card with the parsed layout drawn as labeled boxes (draggable unless read-only). */
function templateCard(lang: Lang, presets: PresetDto[], tpl: TemplateDto, onChanged: () => void, readOnly = false): HTMLElement {
  const card = h('div', { class: 'tpl-card' });
  const assigned = presets.find((x) => x.id === tpl.preset);
  const presetTitle = tpl.preset ? (assigned ? presetName(lang, assigned.id, assigned.label) : tpl.preset) : t(lang, 'brand_default');
  const status = tpl.status === 'ready' ? h('span', { class: 'chip fresh' }, t(lang, 'tpl_status_ready'))
    : tpl.status === 'pending' ? h('span', { class: 'chip' }, t(lang, 'tpl_status_pending'))
    : h('span', { class: 'chip' }, `${t(lang, 'tpl_status_failed')}${tpl.error ? ` — ${tpl.error}` : ''}`);

  const frame = h('div', { class: 'img-frame' });
  const img = h('img', { src: tpl.image, alt: presetTitle }) as HTMLImageElement;
  frame.append(img);
  const layer = h('div', { class: 'overlay' });
  frame.append(layer);

  const paint = (): void => {
    layer.replaceChildren();
    if (!tpl.spec) return;
    zonesOf(lang, tpl.spec).forEach((z, i) => {
      const b = z.get();
      if (!b) return;
      const d = h('div', {
        class: readOnly ? `box ${z.cls}` : `box drag ${z.cls}`,
        style: `left:${(b.x * 100).toFixed(2)}%;top:${(b.y * 100).toFixed(2)}%;width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%`,
      });
      // Alternate the chip above/below the box so nested zones (headline in
      // panel) keep readable labels instead of one merged blob.
      const tagAttrs = i % 2 === 0 ? { class: 'tag' } : { class: 'tag', style: 'top:auto;bottom:-20px' };
      d.append(h('span', tagAttrs, z.label));
      if (readOnly) {
        layer.append(d);
        return;
      }
      // Simple drag: move the box, clamp into the frame.
      d.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
        const rect = frame.getBoundingClientRect();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const orig = { ...b };
        const move = (me: PointerEvent): void => {
          const dx = (me.clientX - startX) / rect.width;
          const dy = (me.clientY - startY) / rect.height;
          const next = {
            x: Math.min(Math.max(0, orig.x + dx), 1 - orig.w),
            y: Math.min(Math.max(0, orig.y + dy), 1 - orig.h),
            w: orig.w,
            h: orig.h,
          };
          z.set(next);
          d.style.left = `${(next.x * 100).toFixed(2)}%`;
          d.style.top = `${(next.y * 100).toFixed(2)}%`;
        };
        const up = (): void => {
          d.removeEventListener('pointermove', move);
          d.removeEventListener('pointerup', up);
        };
        d.addEventListener('pointermove', move);
        d.addEventListener('pointerup', up);
      });
      layer.append(d);
    });
  };
  paint();

  const presetSel = h('select', { class: 'input small' }) as HTMLSelectElement;
  presetSel.append(h('option', { value: '' }, t(lang, 'brand_default')));
  for (const p of presets) presetSel.append(h('option', { value: p.id }, `${presetName(lang, p.id, p.label)} · ${dims(p.width, p.height)}`));
  presetSel.value = tpl.preset ?? '';
  presetSel.addEventListener('change', async () => {
    try {
      await api(`api/templates/${tpl.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: presetSel.value === '' ? null : presetSel.value }) });
      onChanged();
    } catch (e) {
      status.replaceChildren(h('span', { class: 'chip' }, errText(lang, e)));
    }
  });

  const saveBtn = h('button', { type: 'button', class: 'btn secondary small' }, t(lang, 'tpl_save')) as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    if (!tpl.spec) return;
    saveBtn.disabled = true;
    try {
      await api(`api/templates/${tpl.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: tpl.spec }) });
    } catch (e) {
      status.replaceChildren(h('span', { class: 'chip' }, errText(lang, e)));
    } finally {
      saveBtn.disabled = false;
    }
  });
  const rejectBtn = h('button', { type: 'button', class: 'btn secondary small' }, t(lang, 'tpl_reject')) as HTMLButtonElement;
  rejectBtn.addEventListener('click', async () => {
    rejectBtn.disabled = true;
    try {
      await api(`api/templates/${tpl.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      rejectBtn.disabled = false;
      status.replaceChildren(h('span', { class: 'chip' }, errText(lang, e)));
    }
  });

  if (readOnly) presetSel.disabled = true;
  card.append(
    frame,
    h('div', { class: 'tpl-body' },
      h('div', { class: 'tpl-head' }, h('strong', {}, presetTitle), status),
      readOnly ? h('p', { class: 'muted small' }, t(lang, 'demo_readonly')) : null,
      h('div', { class: 'field' }, h('label', {}, t(lang, 'tpl_size')), presetSel),
      tpl.spec && !readOnly ? h('p', { class: 'muted small' }, t(lang, 'tpl_nudge_hint')) : null,
      readOnly ? null : h('div', { class: 'toolbar' }, saveBtn, rejectBtn),
    ),
  );
  return card;
}

export function brandsView(lang: Lang): HTMLElement {
  const root = h('div', {});
  root.append(h('h1', {}, t(lang, 'brands_title')), h('p', { class: 'sub' }, t(lang, 'brands_sub')));
  const list = h('div', {});
  root.append(list);

  const reload = (): void => {
    list.replaceChildren(h('p', { class: 'muted' }, '…'));
    void (async () => {
      let data: { presets: PresetDto[]; brands: BrandDto[] };
      try {
        data = (await api('api/brands')) as { presets: PresetDto[]; brands: BrandDto[] };
      } catch (e) {
        list.replaceChildren(h('p', {}, errText(lang, e)));
        return;
      }
      list.replaceChildren();

      // --- new brand ---
      const nameIn = h('input', { class: 'input', maxlength: '60', placeholder: t(lang, 'brand_name') }) as HTMLInputElement;
      const colorsIn = h('input', { class: 'input', placeholder: '#0f4c5c, #ff5a3c' }) as HTMLInputElement;
      const createBtn = h('button', { type: 'button', class: 'btn' }, t(lang, 'brand_create')) as HTMLButtonElement;
      const createMsg = h('span', { class: 'muted small' });
      createBtn.addEventListener('click', async () => {
        const colors = colorsIn.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!nameIn.value.trim() || colors.some((c) => !/^#[0-9a-fA-F]{6}$/.test(c))) {
          createMsg.textContent = errText(lang, { key: 'err_bad_request' } as never);
          return;
        }
        createBtn.disabled = true;
        try {
          await api('api/brands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: nameIn.value.trim(), colors }) });
          reload();
        } catch (e) {
          createMsg.textContent = errText(lang, e);
          createBtn.disabled = false;
        }
      });
      list.append(
        h('section', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, t(lang, 'brands_new')),
          h('div', { class: 'formrow' },
            h('div', { class: 'field' }, h('label', {}, t(lang, 'brand_name')), nameIn),
            h('div', { class: 'field' }, h('label', {}, t(lang, 'brand_colors')), colorsIn),
          ),
          h('div', { class: 'toolbar' }, createBtn, createMsg),
        ),
      );

      // --- brands ---
      for (const b of data.brands) {
        const sec = h('section', { class: 'card', style: 'margin-top:14px' });
        const headBits: Array<Node | string> = [h('h2', { style: 'margin:0' }, b.name)];
        if (b.demo) headBits.push(h('span', { class: 'chip fresh' }, t(lang, 'brand_demo_tag')));
        if (b.logo) {
          const logo = h('img', { src: b.logo, alt: t(lang, 'logo_label'), class: 'brand-logo' }) as HTMLImageElement;
          headBits.push(logo);
        }
        for (const c of b.colors) {
          const sw = h('span', { class: 'swatch', style: `background:${c}`, title: c });
          headBits.push(sw);
        }
        sec.append(h('div', { class: 'brand-head' }, ...headBits));

        if (!b.demo) {
          // Logo + template uploads (demo brands are fixed fixtures).
          const logoIn = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' }) as HTMLInputElement;
          logoIn.addEventListener('change', async () => {
            const f = logoIn.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append('logo', f);
            try {
              await api(`api/brands/${b.id}/logo`, { method: 'POST', body: fd });
              reload();
            } catch (e) {
              logoIn.after(h('span', { class: 'muted small' }, errText(lang, e)));
            }
          });
          const tplImg = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' }) as HTMLInputElement;
          const tplFrame = h('input', { type: 'file', accept: 'image/png' }) as HTMLInputElement;
          const tplPreset = h('select', { class: 'input small' }) as HTMLSelectElement;
          tplPreset.append(h('option', { value: '' }, t(lang, 'brand_default')));
          for (const p of data.presets) tplPreset.append(h('option', { value: p.id }, `${presetName(lang, p.id, p.label)} · ${dims(p.width, p.height)}`));
          const tplBtn = h('button', { type: 'button', class: 'btn secondary small' }, t(lang, 'tpl_upload')) as HTMLButtonElement;
          tplBtn.addEventListener('click', async () => {
            const f = tplImg.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append('image', f);
            if (tplPreset.value) fd.append('preset', tplPreset.value);
            const fr = tplFrame.files?.[0];
            if (fr) fd.append('frame', fr);
            tplBtn.disabled = true;
            try {
              await api(`api/brands/${b.id}/templates`, { method: 'POST', body: fd });
              reload();
            } catch (e) {
              tplBtn.disabled = false;
              tplBtn.after(h('span', { class: 'muted small' }, errText(lang, e)));
            }
          });
          const delBtn = h('button', { type: 'button', class: 'btn secondary small' }, t(lang, 'brand_delete')) as HTMLButtonElement;
          delBtn.addEventListener('click', async () => {
            delBtn.disabled = true;
            try {
              await api(`api/brands/${b.id}`, { method: 'DELETE' });
              reload();
            } catch (e) {
              delBtn.disabled = false;
              delBtn.after(h('span', { class: 'muted small' }, errText(lang, e)));
            }
          });
          sec.append(
            h('div', { class: 'formrow' },
              h('div', { class: 'field' }, h('label', {}, t(lang, 'logo_label')), logoIn),
              h('div', { class: 'field' }, h('label', {}, t(lang, 'tpl_upload')), tplImg, tplPreset),
              h('div', { class: 'field' }, h('label', {}, t(lang, 'frame_label')), tplFrame),
            ),
            h('div', { class: 'toolbar' }, tplBtn, delBtn),
          );
        }

        sec.append(h('h3', {}, t(lang, 'brand_templates')));
        const grid = h('div', { class: 'tpl-grid' });
        for (const tpl of b.templates) grid.append(templateCard(lang, data.presets, tpl, reload, b.demo));
        if (b.templates.length === 0) grid.append(h('p', { class: 'muted' }, '—'));
        sec.append(grid);
        list.append(sec);
      }
    })();
  };
  reload();
  return root;
}
