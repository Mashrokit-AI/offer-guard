import { ApiError, api, h, t, type Lang } from './lib.js';
import type { Campaign, JobSummary } from './dto.js';

const PAGES = [
  'gali-offer-he.html',
  'gali-offer-en.html',
  'gali-offer-wrong-he.html',
  'gali-offer-wrong-en.html',
];

function field(labelText: string, control: HTMLElement, hint?: string, full = false): HTMLElement {
  const wrap = h('div', { class: full ? 'field full' : 'field' });
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  control.setAttribute('id', id);
  wrap.append(h('label', { for: id }, labelText), control);
  if (hint) wrap.append(h('div', { class: 'hint' }, hint));
  return wrap;
}

export function checkView(lang: Lang): HTMLElement {
  const root = h('div', {});
  root.append(h('h1', {}, t(lang, 'check_title')), h('p', { class: 'sub' }, t(lang, 'check_sub')));
  const form = h('form', { class: 'card' }) as HTMLFormElement;
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png' }) as HTMLInputElement;
  const copyInput = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  const percentInput = h('input', { type: 'number', min: '0', max: '90', value: '20', dir: 'ltr' }) as HTMLInputElement;
  const scopeSel = h('select', {}) as HTMLSelectElement;
  scopeSel.append(
    new Option(t(lang, 'scope_selected'), 'selected_models', true, true),
    new Option(t(lang, 'scope_all'), 'all'),
  );
  const shipSel = h('select', {}) as HTMLSelectElement;
  shipSel.append(
    new Option(t(lang, 'ship_paid'), 'paid', true, true),
    new Option(t(lang, 'ship_free'), 'free'),
  );
  const validInput = h('input', { type: 'date', value: '2026-11-10', dir: 'ltr' }) as HTMLInputElement;
  const pageSel = h('select', {}) as HTMLSelectElement;
  for (const p of PAGES) pageSel.append(new Option(p, p));

  // Prefill the spec from the campaign's current approved offer.
  void api('api/campaign')
    .then((body) => {
      const spec = (body as Campaign).spec;
      if (spec.percent !== null) percentInput.value = String(spec.percent);
      scopeSel.value = spec.scope === 'all' ? 'all' : 'selected_models';
      shipSel.value = spec.shipping === 'free' ? 'free' : 'paid';
      if (spec.validFull) validInput.value = spec.validFull;
    })
    .catch(() => {
      // Prefill is a convenience; the GALI defaults above stand on their own.
    });

  const grid = h('div', { class: 'form-grid' });
  grid.append(
    field(t(lang, 'check_image'), fileInput, t(lang, 'check_upload_hint'), true),
    field(t(lang, 'check_copy'), copyInput, undefined, true),
    field(t(lang, 'check_discount'), percentInput),
    field(t(lang, 'check_valid'), validInput),
    field(t(lang, 'check_scope'), scopeSel),
    field(t(lang, 'check_shipping'), shipSel),
    field(t(lang, 'check_page'), pageSel, t(lang, 'check_page_note'), true),
  );
  const submit = h('button', { class: 'btn', type: 'submit' }, t(lang, 'check_submit')) as HTMLButtonElement;
  const status = h('span', { class: 'muted', role: 'status' });
  form.append(grid, h('div', { class: 'form-actions' }, submit, status));
  root.append(form);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) {
      status.replaceChildren(h('span', { class: 'form-error' }, t(lang, 'err_bad_image')));
      return;
    }
    submit.disabled = true;
    status.textContent = t(lang, 'check_analyzing');
    const fd = new FormData();
    fd.append('image', file);
    fd.append('copy', copyInput.value);
    fd.append('percent', percentInput.value);
    fd.append('scope', scopeSel.value);
    fd.append('shipping', shipSel.value);
    fd.append('valid', validInput.value);
    fd.append('page', pageSel.value);
    void (async () => {
      let jobId: string;
      try {
        const res = (await api('api/checks', { method: 'POST', body: fd })) as { jobId: string };
        jobId = res.jobId;
      } catch (e) {
        const key = e instanceof ApiError ? e.key : 'err_unknown';
        status.replaceChildren(h('span', { class: 'form-error' }, t(lang, key as Parameters<typeof t>[1])));
        submit.disabled = false;
        return;
      }
      const poll = async (): Promise<void> => {
        try {
          const res = (await api(`api/jobs/${jobId}`)) as { job: JobSummary };
          const job = res.job;
          if (job.status === 'done' && job.snapshotId !== undefined) {
            window.location.hash = `#/ad/${job.snapshotId}${job.cached ? '?cached=1' : ''}`;
            return;
          }
          if (job.status === 'failed') {
            status.replaceChildren(
              h('span', { class: 'form-error' }, t(lang, (job.error ?? 'err_job_failed') as Parameters<typeof t>[1])),
            );
            submit.disabled = false;
            return;
          }
          window.setTimeout(() => void poll(), 2000);
        } catch {
          window.setTimeout(() => void poll(), 3000);
        }
      };
      // Prefer SSE, fall back to polling.
      try {
        const sse = new EventSource(`api/jobs/${jobId}/events`);
        let settled = false;
        sse.onmessage = (m: MessageEvent) => {
          try {
            const e = JSON.parse(m.data as string) as { type: string; snapshotId?: number; cached?: boolean; error?: string };
            if (e.type === 'done' && e.snapshotId !== undefined) {
              settled = true;
              sse.close();
              window.location.hash = `#/ad/${e.snapshotId}${e.cached ? '?cached=1' : ''}`;
            } else if (e.type === 'failed') {
              settled = true;
              sse.close();
              status.replaceChildren(
                h('span', { class: 'form-error' }, t(lang, (e.error ?? 'err_job_failed') as Parameters<typeof t>[1])),
              );
              submit.disabled = false;
            }
          } catch {
            // Malformed event; polling below still converges.
          }
        };
        sse.onerror = () => {
          if (settled) return;
          sse.close();
          void poll();
        };
        window.setTimeout(() => {
          if (!settled) void poll();
        }, 20000);
      } catch {
        void poll();
      }
    })();
  });
  return root;
}
