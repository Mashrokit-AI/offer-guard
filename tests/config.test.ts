import { describe, expect, it } from 'vitest';
import { loadConfig, loadModelConfig } from '../src/shared/config.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  META_ACCESS_TOKEN: 'test-token-abcdef123456',
  META_GRAPH_VERSION: 'v25.0',
  META_AD_ACCOUNT_ID: '111111111111111',
  META_PAGE_ID: '222222222222222',
  META_ADSET_ID: '33333333333333',
  META_TEST_LINK_URL: 'https://example.com/test',
  MODEL_API_KEY: '',
  MODEL_API_BASE: 'https://api.meta.ai/v1',
};

describe('loadConfig', () => {
  it('accepts a complete valid env', () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config.META_GRAPH_VERSION).toBe('v25.0');
    expect(config.META_AD_ACCOUNT_ID).toBe('111111111111111');
    expect(config.META_TEST_LINK_URL).toBe('https://example.com/test');
  });

  it('applies defaults for graph version, model key and model base', () => {
    const { META_GRAPH_VERSION: _g, MODEL_API_KEY: _k, MODEL_API_BASE: _b, ...rest } = VALID_ENV;
    const config = loadConfig({ ...rest });
    expect(config.META_GRAPH_VERSION).toBe('v25.0');
    expect(config.MODEL_API_KEY).toBe('');
    expect(config.MODEL_API_BASE).toBe('https://api.meta.ai/v1');
  });

  it('rejects a missing access token', () => {
    const { META_ACCESS_TOKEN: _t, ...rest } = VALID_ENV;
    expect(() => loadConfig({ ...rest })).toThrow(/META_ACCESS_TOKEN/);
  });

  it('rejects an empty access token', () => {
    expect(() => loadConfig({ ...VALID_ENV, META_ACCESS_TOKEN: '   ' })).toThrow(/META_ACCESS_TOKEN/);
  });

  it('rejects an ad account id with the act_ prefix', () => {
    expect(() => loadConfig({ ...VALID_ENV, META_AD_ACCOUNT_ID: 'act_111111111111111' })).toThrow(
      /without the act_ prefix/,
    );
  });

  it('rejects non-numeric page and ad set ids', () => {
    expect(() => loadConfig({ ...VALID_ENV, META_PAGE_ID: 'abc' })).toThrow(/META_PAGE_ID/);
    expect(() => loadConfig({ ...VALID_ENV, META_ADSET_ID: '12ab' })).toThrow(/META_ADSET_ID/);
  });

  it('rejects a malformed graph version', () => {
    expect(() => loadConfig({ ...VALID_ENV, META_GRAPH_VERSION: '25' })).toThrow(/META_GRAPH_VERSION/);
  });

  it('rejects a non-URL test link', () => {
    expect(() => loadConfig({ ...VALID_ENV, META_TEST_LINK_URL: 'not-a-url' })).toThrow(/META_TEST_LINK_URL/);
  });
});

describe('loadModelConfig', () => {
  it('loads from the model key + base only (no Meta token required)', () => {
    const config = loadModelConfig({ MODEL_API_KEY: 'model-key-placeholder-12345678' });
    expect(config.MODEL_API_BASE).toBe('https://api.meta.ai/v1');
    expect(config.MODEL_EXTRACT).toBe('muse-spark-1.3');
    expect(config.MODEL_SAM).toBe('sam-3.1');
  });

  it('honors model name overrides', () => {
    const config = loadModelConfig({
      MODEL_API_KEY: 'model-key-placeholder-12345678',
      MODEL_API_BASE: 'https://models.example.com/v1',
      MODEL_EXTRACT: 'custom-extract',
      MODEL_SAM: 'custom-sam',
    });
    expect(config.MODEL_API_BASE).toBe('https://models.example.com/v1');
    expect(config.MODEL_EXTRACT).toBe('custom-extract');
    expect(config.MODEL_SAM).toBe('custom-sam');
  });

  it('rejects a missing model key', () => {
    expect(() => loadModelConfig({})).toThrow(/MODEL_API_KEY/);
    expect(() => loadModelConfig({ MODEL_API_KEY: '   ' })).toThrow(/MODEL_API_KEY/);
  });

  it('rejects a non-URL model base', () => {
    expect(() => loadModelConfig({ MODEL_API_KEY: 'k'.repeat(20), MODEL_API_BASE: 'not-a-url' })).toThrow(
      /MODEL_API_BASE/,
    );
  });
});
