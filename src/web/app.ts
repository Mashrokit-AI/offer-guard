import { applyLang, brandSvg, getLang, h, setLang, t, BRAND_NAME, type Lang } from './lib.js';
import { homeView } from './home.js';
import { outputView } from './output.js';
import { brandsView } from './brands.js';
import { aboutView } from './about.js';

const REPO = 'https://github.com/Mashrokit-AI/matchpic';

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
      h('a', { class: 'brand', href: '#/' }, brandSvg(), h('span', { class: 'brand-name' }, BRAND_NAME)),
      h('span', { class: 'tagline' }, t(lang, 'app_tagline')),
      h('nav', { class: 'nav' },
        navLink('#/', t(lang, 'nav_home'), 'home'),
        navLink('#/brands', t(lang, 'nav_brands'), 'brands'),
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
  const [path] = raw.split('?');
  let route = 'home';
  let main: HTMLElement;
  let anchor: string | null = null;
  const outMatch = (path ?? '').match(/^\/output\/(\d+)$/);
  const aboutMatch = (path ?? '').match(/^\/about(?:\/([\w-]+))?$/);
  if (outMatch) {
    route = 'output';
    main = outputView(lang, Number(outMatch[1]));
  } else if (path === '/brands') {
    route = 'brands';
    main = brandsView(lang);
  } else if (aboutMatch) {
    route = 'about';
    main = aboutView(lang);
    anchor = aboutMatch[1] ?? null;
  } else {
    main = homeView(lang);
  }
  mount.replaceChildren(shell(lang, main, route));
  const target = anchor ? document.getElementById(anchor) : null;
  if (target) target.scrollIntoView({ block: 'center' });
  else window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
