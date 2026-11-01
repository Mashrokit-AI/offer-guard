import { applyLang, getLang, h, setLang, shieldSvg, t, type Lang } from './lib.js';
import { campaignView } from './campaign.js';
import { detailView } from './detail.js';
import { checkView } from './check.js';
import { aboutView } from './about.js';

const REPO = 'https://github.com/Mashrokit-AI/offer-guard';

function shell(lang: Lang, main: HTMLElement, route: string): HTMLElement {
  const app = h('div', {});
  const navLink = (hash: string, label: string, key: string): HTMLElement =>
    h('a', { href: hash, ...(route === key ? { 'aria-current': 'page' } : {}) }, label);
  const enBtn = h('button', { type: 'button', 'aria-pressed': lang === 'en' ? 'true' : 'false' }, 'EN') as HTMLButtonElement;
  const heBtn = h('button', { type: 'button', 'aria-pressed': lang === 'he' ? 'true' : 'false' }, 'עב') as HTMLButtonElement;
  enBtn.addEventListener('click', () => switchLang('en'));
  heBtn.addEventListener('click', () => switchLang('he'));
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '#/' }, shieldSvg(), h('span', { class: 'brand-name' }, t(lang, 'app_name'))),
      h('span', { class: 'tagline' }, t(lang, 'app_tagline')),
      h('nav', { class: 'nav' },
        navLink('#/', t(lang, 'nav_campaign'), 'campaign'),
        navLink('#/check', t(lang, 'nav_check'), 'check'),
        navLink('#/about', t(lang, 'nav_about'), 'about'),
      ),
      h('div', { class: 'lang-toggle', role: 'group', 'aria-label': 'EN / עב' }, enBtn, heBtn),
    ),
  );
  const footer = h('footer', { class: 'footer' },
    h('span', {}, t(lang, 'footer_synthetic')),
    h('a', { href: REPO, target: '_blank', rel: 'noopener' }, t(lang, 'footer_repo')),
  );
  const wrap = h('div', { class: 'wrap' }, main, footer);
  app.append(header, wrap);
  return app;
}

function switchLang(lang: Lang): void {
  setLang(lang);
  applyLang(lang);
  render();
}

function render(): void {
  const lang = getLang();
  applyLang(lang);
  const mount = document.getElementById('app');
  if (!mount) return;
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query ?? '');
  let route = 'campaign';
  let main: HTMLElement;
  const adMatch = (path ?? '').match(/^\/ad\/(\d+)$/);
  if (adMatch) {
    route = 'detail';
    main = detailView(lang, Number(adMatch[1]), params.get('cached') === '1');
  } else if (path === '/check') {
    route = 'check';
    main = checkView(lang);
  } else if (path === '/about') {
    route = 'about';
    main = aboutView(lang);
  } else {
    main = campaignView(lang);
  }
  mount.replaceChildren(shell(lang, main, route));
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
