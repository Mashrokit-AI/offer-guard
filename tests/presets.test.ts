import { describe, expect, it } from 'vitest';
import { PRESETS, metaPresetIds, presetById, presetSafeRect } from '../src/shared/presets.js';

describe('preset table', () => {
  it('has exactly the 8 placements with exact pixel sizes', () => {
    expect(PRESETS).toHaveLength(8);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(8);
    const sizes: Record<string, [number, number]> = {
      'ig-feed-11': [1080, 1080],
      'ig-feed-45': [1080, 1350],
      'ig-story-916': [1080, 1920],
      'fb-feed': [1200, 1200],
      'fb-link': [1200, 628],
      'li-post': [1200, 627],
      'yt-thumb': [1280, 720],
      'tiktok-916': [1080, 1920],
    };
    for (const [id, [w, h]] of Object.entries(sizes)) {
      const p = presetById(id);
      expect(p, id).not.toBeNull();
      expect([p?.width, p?.height]).toEqual([w, h]);
    }
  });

  it('keeps top 14% / bottom 20% clear on 9:16 for UI overlays', () => {
    for (const id of ['ig-story-916', 'tiktok-916']) {
      const p = presetById(id);
      expect(p?.safe.top).toBe(0.14);
      expect(p?.safe.bottom).toBe(0.2);
    }
    const story = presetById('ig-story-916');
    const safe = presetSafeRect(story!);
    expect(safe.y).toBe(Math.round(1920 * 0.14));
    expect(safe.h).toBe(1920 - Math.round(1920 * 0.14) - Math.round(1920 * 0.2));
  });

  it('resolves the Meta shortcut to the 5 Meta placements', () => {
    expect(metaPresetIds().sort()).toEqual(['fb-feed', 'fb-link', 'ig-feed-11', 'ig-feed-45', 'ig-story-916'].sort());
  });

  it('returns null for unknown ids', () => {
    expect(presetById('nope')).toBeNull();
  });
});
