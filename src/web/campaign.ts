import { ApiError, api, fmtTime, h, msg, t, verdictBadge, type Lang } from './lib.js';
import type { Campaign, CampaignAd, JobSummary, SpecDto } from './dto.js';

export function specLines(lang: Lang, spec: SpecDto): string[] {
  const scope =
    spec.scope === 'all'
      ? t(lang, 'scope_all')
      : spec.scope === 'selected_models'
        ? t(lang, 'scope_selected')
        : t(lang, 'scope_unspecified');
  const ship =
    spec.shipping === 'free'
      ? t(lang, 'ship_free')
      : spec.shipping === 'paid'
        ? t(lang, 'ship_paid')
        : t(lang, 'ship_unspecified');
  const discount =
    spec.percent === null ? scope : t(lang, 'spec_discount_line', { percent: spec.percent, scope });
  const valid = spec.validFull
    ? t(lang, 'spec_valid_line', { date: spec.validFull.split('-').reverse().join('.') })
    : t(lang, 'spec_valid_none');
  return [discount, valid, ship];
}

const COUNTERS: Array<{ verdict: string; key: 'counter_clean' | 'counter_fixed' | 'counter_refused' | 'counter_page_wrong' | 'counter_ambiguous'; cls: string }> = [
  { verdict: 'CLEAN', key: 'counter_clean', cls: 'c-clean' },
  { verdict: 'AD_WRONG_REPAIRABLE', key: 'counter_fixed', cls: 'c-fixed' },
  { verdict: 'AD_WRONG_UNSAFE', key: 'counter_refused', cls: 'c-refused' },
  { verdict: 'PAGE_WRONG', key: 'counter_page_wrong', cls: 'c-page' },
  { verdict: 'AMBIGUOUS', key: 'counter_ambiguous', cls: 'c-amb' },
];

function adCard(lang: Lang, ad: CampaignAd): HTMLElement {
  const a = h(
    'a',
    { class: 'ad-card', href: `#/ad/${ad.id}` },
    h('img', { class: 'thumb', src: ad.thumb, alt: ad.adKey, loading: 'lazy' }),
    h(
      'div',
      { class: 'ad-card-body' },
      verdictBadge(lang, ad.verdict),
      h('div', { class: 'ad-card-reason', dir: 'auto' }, msg(lang, ad.reason)),
      h(
        'div',
        { class: 'ad-card-meta' },
        h('span', { class: 'lang-tag' }, ad.lang.toUpperCase()),
        h(
          'span',
          {},
          ad.cached ? t(lang, 'card_saved') : t(lang, 'card_fresh'),
          ' · ',
          h('span', { dir: 'ltr' }, t(lang, 'card_captured', { time: fmtTime(lang, ad.captureTime) })),
        ),
      ),
    ),
  );
  a.dataset.adkey = `${ad.ad}/${ad.lang}`;
  a.dataset.verdict = ad.verdict;
  return a;
}

async function runFresh(
  lang: Lang,
  btn: HTMLButtonElement,
  banner: HTMLElement,
  grid: HTMLElement,
  onDone: () => void,
): Promise<void> {
  btn.disabled = true;
  banner.replaceChildren(h('span', {}, t(lang, 'job_queued')));
  let jobId: string;
  try {
    const res = (await api('api/runs/fresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })) as { jobId: string };
    jobId = res.jobId;
  } catch (e) {
    const key = e instanceof ApiError ? e.key : 'err_unknown';
    banner.replaceChildren(h('span', { class: 'form-error' }, t(lang, key as Parameters<typeof t>[1])));
    btn.disabled = false;
    return;
  }
  const label = h('span', {});
  const bar = h('div', {}, h('div', {})) as HTMLElement;
  bar.className = 'progress';
  const fill = bar.firstChild as HTMLElement;
  banner.replaceChildren(label, bar);

  const applyRows = (rows: JobSummary['rows'], done: number, total: number): void => {
    label.textContent = t(lang, 'job_running', { done, total });
    fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
    for (const row of rows) {
      const card = grid.querySelector(`[data-adkey="${row.ad}/${row.lang}"]`);
      if (!card) continue;
      const body = card.querySelector('.ad-card-body');
      if (!body) continue;
      const old = body.querySelector('.badge');
      const fresh = verdictBadge(lang, row.got);
      if (old) old.replaceWith(fresh);
      card.setAttribute('data-verdict', row.got);
    }
  };

  const finish = (ok: boolean, errorKey?: string): void => {
    stopPoll();
    stopSse();
    if (ok) {
      banner.replaceChildren(h('span', {}, t(lang, 'job_done')));
      window.setTimeout(() => banner.replaceChildren(), 2500);
      onDone();
    } else {
      banner.replaceChildren(
        h('span', { class: 'form-error' }, t(lang, (errorKey ?? 'err_job_failed') as Parameters<typeof t>[1])),
      );
    }
    btn.disabled = false;
  };

  let pollTimer = 0;
  let sse: EventSource | null = null;
  const stopPoll = (): void => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  };
  const stopSse = (): void => {
    if (sse) sse.close();
    sse = null;
  };
  const pollOnce = async (): Promise<void> => {
    try {
      const res = (await api(`api/jobs/${jobId}`)) as { job: JobSummary };
      applyRows(res.job.rows, res.job.done, res.job.total);
      if (res.job.status === 'done') finish(true);
      else if (res.job.status === 'failed') finish(false, res.job.error);
    } catch {
      // A transient poll failure must not kill the run view; SSE or retry covers it.
    }
  };
  try {
    sse = new EventSource(`api/jobs/${jobId}/events`);
    sse.onmessage = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data as string) as
          | { type: 'progress'; done: number; total: number; row: JobSummary['rows'][number] }
          | { type: 'done' | 'failed'; done: number; total: number; error?: string };
        if (e.type === 'progress') applyRows([e.row], e.done, e.total);
        else if (e.type === 'done') finish(true);
        else finish(false, e.error);
      } catch {
        // Ignore a malformed event; the next poll/event recovers.
      }
    };
    sse.onerror = () => {
      stopSse();
      if (!pollTimer) pollTimer = window.setInterval(() => void pollOnce(), 2000);
    };
  } catch {
    pollTimer = window.setInterval(() => void pollOnce(), 2000);
  }
  // Safety net: if SSE silently stalls, a poll still completes the run.
  window.setTimeout(() => {
    if (!pollTimer && sse) void pollOnce();
  }, 15000);
}

export function campaignView(lang: Lang): HTMLElement {
  const root = h('div', {});
  root.append(h('p', { class: 'muted' }, '…'));
  let verdictFilter: string | null = null;
  let langFilter: string | null = null;

  const render = (data: Campaign): void => {
    root.replaceChildren();
    const specCard = h(
      'section',
      { class: 'card spec-card', 'aria-label': t(lang, 'spec_title') },
      h(
        'div',
        {},
        h('div', { class: 'spec-title' }, t(lang, 'spec_title')),
        h('div', { class: 'spec-lines' }, ...specLines(lang, data.spec).map((s) => h('span', {}, s))),
      ),
      h('span', { class: 'chip', dir: 'ltr' }, t(lang, 'spec_version', { version: data.spec.version })),
      h(
        'span',
        { class: `chip${data.run.mode === 'fresh' ? ' fresh' : ''}` },
        data.run.mode === 'fresh' ? t(lang, 'run_mode_fresh') : t(lang, 'run_mode_saved'),
      ),
    );
    root.append(specCard);

    const counters = h('div', { class: 'counters', role: 'group', 'aria-label': t(lang, 'filter_verdict_all') });
    for (const c of COUNTERS) {
      const n = data.run.countsByVerdict[c.verdict] ?? 0;
      const b = h(
        'button',
        { class: `counter ${c.cls}`, type: 'button', 'aria-pressed': verdictFilter === c.verdict ? 'true' : 'false' },
        h('div', { class: 'n', dir: 'ltr' }, String(n)),
        h('div', { class: 'l' }, t(lang, c.key)),
      );
      b.addEventListener('click', () => {
        verdictFilter = verdictFilter === c.verdict ? null : c.verdict;
        render(data);
      });
      counters.append(b);
    }
    root.append(counters);

    const grid = h('div', { class: 'grid' });
    const applyFilters = (): void => {
      grid.replaceChildren();
      for (const ad of data.ads) {
        if (verdictFilter && ad.verdict !== verdictFilter) continue;
        if (langFilter && ad.lang !== langFilter) continue;
        grid.append(adCard(lang, ad));
      }
    };

    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t(lang, 'filter_language') });
    const langBtn = (value: string | null, label: string): HTMLElement => {
      const b = h(
        'button',
        { type: 'button', 'aria-pressed': langFilter === value ? 'true' : 'false' },
        label,
      );
      b.addEventListener('click', () => {
        langFilter = value;
        render(data);
      });
      return b;
    };
    seg.append(
      langBtn(null, t(lang, 'filter_all')),
      langBtn('he', t(lang, 'filter_he')),
      langBtn('en', t(lang, 'filter_en')),
    );

    const btn = h('button', { class: 'btn', type: 'button' }, t(lang, 'btn_run_fresh')) as HTMLButtonElement;
    const banner = h('div', { class: 'job-banner', hidden: 'true' }) as HTMLElement;
    btn.addEventListener('click', () => {
      banner.hidden = false;
      void runFresh(lang, btn, banner, grid, () => void reload());
    });
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'run-caption', dir: 'auto' }, t(lang, 'run_caption', { id: data.run.id, mode: data.run.mode === 'fresh' ? t(lang, 'run_mode_fresh') : t(lang, 'run_mode_saved'), count: data.ads.length })),
      seg,
      btn,
    );
    root.append(toolbar, banner);

    const steps = h(
      'ol',
      { class: 'steps' },
      ...(
        [
          ['step1_title', 'step1_tip'],
          ['step2_title', 'step2_tip'],
          ['step3_title', 'step3_tip'],
        ] as const
      ).map(([tk, dk], i) =>
        h('li', { title: t(lang, dk) }, h('span', { class: 'step-n', dir: 'ltr' }, String(i + 1)), t(lang, tk)),
      ),
    );
    root.append(steps);
    applyFilters();
    root.append(grid);
  };

  const reload = async (): Promise<void> => {
    try {
      render((await api('api/campaign')) as Campaign);
    } catch (e) {
      const key = e instanceof ApiError ? e.key : 'err_unknown';
      root.replaceChildren(h('p', { class: 'form-error' }, t(lang, key as Parameters<typeof t>[1])));
    }
  };
  void reload();
  return root;
}
