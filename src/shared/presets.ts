/**
 * Placement presets in one table: id, exact pixel size, and safe-area insets
 * as fractions of width/height (kept clear of important content because the
 * platform draws its own UI there — e.g. top 14% / bottom 20% on 9:16 stories).
 */
export interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
  safe: { top: number; bottom: number; left: number; right: number };
  meta: boolean;
}

export const PRESETS: Preset[] = [
  { id: 'ig-feed-11', label: 'Instagram feed 1:1', width: 1080, height: 1080, safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, meta: true },
  { id: 'ig-feed-45', label: 'Instagram feed 4:5', width: 1080, height: 1350, safe: { top: 0.04, bottom: 0.06, left: 0.04, right: 0.04 }, meta: true },
  { id: 'ig-story-916', label: 'Stories / Reels 9:16', width: 1080, height: 1920, safe: { top: 0.14, bottom: 0.2, left: 0.05, right: 0.05 }, meta: true },
  { id: 'fb-feed', label: 'Facebook feed', width: 1200, height: 1200, safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, meta: true },
  { id: 'fb-link', label: 'Facebook link', width: 1200, height: 628, safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, meta: true },
  { id: 'li-post', label: 'LinkedIn post', width: 1200, height: 627, safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, meta: false },
  { id: 'yt-thumb', label: 'YouTube thumbnail', width: 1280, height: 720, safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, meta: false },
  { id: 'tiktok-916', label: 'TikTok 9:16', width: 1080, height: 1920, safe: { top: 0.14, bottom: 0.2, left: 0.05, right: 0.05 }, meta: false },
];

export function presetById(id: string): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** Ids of every Meta placement (the "all Meta placements" shortcut). */
export function metaPresetIds(): string[] {
  return PRESETS.filter((p) => p.meta).map((p) => p.id);
}

/** Safe-area rectangle in pixels for a preset. */
export function presetSafeRect(p: Preset): { x: number; y: number; w: number; h: number } {
  const x = Math.round(p.width * p.safe.left);
  const y = Math.round(p.height * p.safe.top);
  return {
    x,
    y,
    w: p.width - x - Math.round(p.width * p.safe.right),
    h: p.height - y - Math.round(p.height * p.safe.bottom),
  };
}
