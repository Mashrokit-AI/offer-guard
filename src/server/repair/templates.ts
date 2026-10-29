import type { AdLanguage } from '../../shared/schemas.js';
import type { OfferSpec } from './spec.js';

export interface PanelCopy {
  main: string;
  sub: string;
}

/**
 * Approved templates, filled ONLY from spec fields — no free text, no
 * model-written copy. Template language = the ad's detected language.
 *
 * he: main `{percent}% הנחה על {דגמים נבחרים|הכל}`
 *     sub  `בתוקף עד {DD.MM} · משלוח {בתשלום|חינם}`
 * en: main `{percent}% off {selected models|everything}`
 *     sub  `Valid until {DD.MM} · {paid shipping|free shipping}`
 */
export function buildPanelCopy(spec: OfferSpec, lang: AdLanguage): PanelCopy {
  if (spec.percent === null) throw new Error('cannot render a panel: spec has no discount percent');
  if (spec.scope === 'unspecified') throw new Error('cannot render a panel: spec scope is unspecified');
  if (spec.shipping === 'unspecified') throw new Error('cannot render a panel: spec shipping is unspecified');
  if (spec.dayMonth === null) throw new Error('cannot render a panel: spec has no expiry date');

  if (lang === 'he') {
    const scope = spec.scope === 'all' ? 'הכל' : 'דגמים נבחרים';
    const shipping = spec.shipping === 'free' ? 'חינם' : 'בתשלום';
    return {
      main: `${spec.percent}% הנחה על ${scope}`,
      sub: `בתוקף עד ${spec.dayMonth} · משלוח ${shipping}`,
    };
  }
  const scope = spec.scope === 'all' ? 'everything' : 'selected models';
  const shipping = spec.shipping === 'free' ? 'free shipping' : 'paid shipping';
  return {
    main: `${spec.percent}% off ${scope}`,
    sub: `Valid until ${spec.dayMonth} · ${shipping}`,
  };
}
