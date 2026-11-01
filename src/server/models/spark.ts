import OpenAI from 'openai';
import type { z } from 'zod';
import { normalizeUsage, timed, withModelRetry, type ModelUsage } from './client.js';

export type StructuredOutputMode = 'response_format' | 'json-only';

export interface StructuredAttempt {
  mode: StructuredOutputMode;
  rawText: string;
  latencyMs: number;
  usage: ModelUsage | undefined;
  zodError: string | null;
}

export interface StructuredImage {
  imageBytes: Buffer;
  mimeType: string;
}

export interface StructuredInput {
  model: string;
  system: string;
  userText: string;
  images: StructuredImage[];
  /** Hand-written JSON Schema mirror of the Zod schema (strict compatible). */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}

export class StructuredError extends Error {
  readonly attempts: StructuredAttempt[];
  constructor(message: string, attempts: StructuredAttempt[], options?: { cause?: unknown }) {
    super(message);
    this.name = 'StructuredError';
    this.attempts = attempts;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Pull one JSON object out of possibly chatty model text. */
export function extractJsonObject(rawText: string): unknown {
  let text = rawText.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`No JSON object found in model output (first 200 chars: ${JSON.stringify(rawText.slice(0, 200))})`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

function buildMessages(input: StructuredInput, jsonOnly: boolean): ChatMessage[] {
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: jsonOnly ? `${input.userText}\nReply with ONLY a single JSON object, no prose, no code fences.` : input.userText },
  ];
  for (const img of input.images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.imageBytes.toString('base64')}` } });
  }
  return [
    { role: 'system', content: input.system },
    { role: 'user', content },
  ];
}

async function chatOnce(
  client: OpenAI,
  input: StructuredInput,
  messages: ChatMessage[],
  mode: StructuredOutputMode,
): Promise<{ rawText: string; latencyMs: number; usage: ModelUsage | undefined }> {
  const body: Record<string, unknown> = { model: input.model, messages, temperature: 0 };
  if (mode === 'response_format') {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: input.schemaName, schema: input.jsonSchema, strict: true },
    };
  }
  const params = { ...body, stream: false as const };
  const { result, latencyMs } = await timed(() =>
    withModelRetry(() => client.chat.completions.create(params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)),
  );
  const rawText = result.choices[0]?.message?.content ?? '';
  return { rawText, latencyMs, usage: normalizeUsage(result.usage) };
}

function isFallbackableRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422);
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}

/**
 * One structured Spark call: JSON-schema structured output first, "JSON only"
 * + local Zod parse when the API rejects response_format, one retry on
 * invalid JSON with the validation error fed back.
 */
export async function structuredCall<T>(
  client: OpenAI,
  input: StructuredInput,
  schema: z.ZodType<T>,
): Promise<{ parsed: T; outputMode: StructuredOutputMode; attempts: StructuredAttempt[]; totalLatencyMs: number }> {
  const attempts: StructuredAttempt[] = [];
  let mode: StructuredOutputMode = 'response_format';
  let messages = buildMessages(input, false);

  for (let n = 0; ; n++) {
    let rawText: string;
    let latencyMs: number;
    let usage: ModelUsage | undefined;
    try {
      ({ rawText, latencyMs, usage } = await chatOnce(client, input, messages, mode));
    } catch (err) {
      if (mode === 'response_format' && n === 0 && isFallbackableRejection(err)) {
        mode = 'json-only';
        messages = buildMessages(input, true);
        continue;
      }
      throw new StructuredError(`Structured request failed (${mode}): ${formatErr(err)}`, attempts, { cause: err });
    }

    let zodError: string | null = null;
    let parsed: T | null = null;
    try {
      parsed = schema.parse(extractJsonObject(rawText));
    } catch (err) {
      zodError = err instanceof Error ? err.message : String(err);
    }
    attempts.push({ mode, rawText, latencyMs, usage, zodError });

    if (parsed) {
      return {
        parsed,
        outputMode: mode,
        attempts,
        totalLatencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
      };
    }

    if (attempts.length >= 2) {
      throw new StructuredError(`Invalid ${input.schemaName} JSON after retry (${mode}): ${zodError}`, attempts);
    }
    messages = [
      ...messages,
      { role: 'assistant', content: rawText },
      {
        role: 'user',
        content: `Your previous reply was not valid ${input.schemaName} JSON: ${zodError}\nReply with ONLY the corrected JSON object, nothing else.`,
      },
    ];
  }
}
