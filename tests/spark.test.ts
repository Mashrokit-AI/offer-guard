import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJsonObject, structuredCall } from '../src/server/models/spark.js';

const tiny = z.object({ answer: z.string() });

function mockClient(script: Array<{ text?: string; error?: unknown }>): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const step = script[Math.min(i++, script.length - 1)]!;
          if (step.error) throw step.error;
          return { choices: [{ message: { content: step.text ?? '' } }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } };
        },
      },
    },
  } as unknown as OpenAI;
}

const input = {
  model: 'test-model',
  system: 'sys',
  userText: 'hi',
  images: [],
  jsonSchema: { type: 'object' } as Record<string, unknown>,
  schemaName: 'Tiny',
};

describe('extractJsonObject', () => {
  it('pulls JSON out of fences and chatty text', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a":1} done.')).toEqual({ a: 1 });
  });

  it('throws when there is no object', () => {
    expect(() => extractJsonObject('no json here')).toThrow(/No JSON object/);
  });
});

describe('structuredCall', () => {
  it('parses structured output on the first try', async () => {
    const client = mockClient([{ text: '{"answer":"yes"}' }]);
    const res = await structuredCall(client, input, tiny);
    expect(res.parsed).toEqual({ answer: 'yes' });
    expect(res.outputMode).toBe('response_format');
    expect(res.attempts).toHaveLength(1);
  });

  it('falls back to json-only when the API rejects response_format', async () => {
    const err = new OpenAI.APIError(400, { error: { message: 'bad' } } as never, 'bad', new Headers());
    const client = mockClient([{ error: err }, { text: '{"answer":"ok"}' }]);
    const res = await structuredCall(client, input, tiny);
    expect(res.parsed).toEqual({ answer: 'ok' });
    expect(res.outputMode).toBe('json-only');
  });

  it('retries once on invalid JSON, then throws with attempts', async () => {
    const client = mockClient([{ text: '{"nope":1}' }, { text: 'still bad' }]);
    await expect(structuredCall(client, input, tiny)).rejects.toThrow(/Invalid Tiny JSON after retry/);
  });
});
