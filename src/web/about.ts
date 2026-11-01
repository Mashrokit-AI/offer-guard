import { h, t, type Lang } from './lib.js';

const REPO = 'https://github.com/Mashrokit-AI/offer-guard';
const BUILD_LOG = 'https://github.com/Mashrokit-AI/offer-guard/blob/main/docs/build/BUILD_LOG.md';

export function aboutView(lang: Lang): HTMLElement {
  const root = h('div', {});
  root.append(h('h1', {}, t(lang, 'about_title')));
  const steps: Array<['about_step1' | 'about_step2' | 'about_step3' | 'about_step4' | 'about_step5', string | null]> = [
    ['about_step1', 'muse-spark-1.3'],
    ['about_step2', 'muse-spark-1.3'],
    ['about_step3', null],
    ['about_step4', 'sam-3.1'],
    ['about_step5', 'muse-spark-1.3'],
  ];
  const ol = h('ol', { class: 'about-list' });
  for (const [key, model] of steps) {
    const li = h('li', {}, t(lang, key));
    if (model) li.append(' ', h('span', { class: 'model-tag', dir: 'ltr' }, model));
    ol.append(li);
  }
  root.append(
    h('section', { class: 'card' }, h('h2', { style: 'margin-top:0' }, t(lang, 'about_how')), ol),
  );
  const limits = h('ul', { class: 'about-list' });
  for (const key of ['about_limit1', 'about_limit2', 'about_limit3'] as const) {
    limits.append(h('li', {}, t(lang, key)));
  }
  root.append(
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, t(lang, 'about_limits')), limits),
    h('section', { class: 'card', style: 'margin-top:14px' },
      h('h2', { style: 'margin-top:0' }, t(lang, 'about_links')),
      h('p', {},
        h('a', { href: REPO, target: '_blank', rel: 'noopener' }, t(lang, 'footer_repo')),
        ' · ',
        h('a', { href: BUILD_LOG, target: '_blank', rel: 'noopener', dir: 'ltr' }, 'docs/build/BUILD_LOG.md'),
      ),
    ),
  );
  return root;
}
