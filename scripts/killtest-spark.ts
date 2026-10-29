#!/usr/bin/env tsx
/**
 * Day-1 kill test: Hebrew extraction (Spark 1.3).
 *
 * Runs ad-01, ad-02 and ad-03 through extractAdClaims and scores each field
 * against tests/fixtures/ground-truth.json. Model API only (read-only);
 * never touches the Graph API.
 *
 *   npm run killtest:spark
 *
 * Raw requests/responses land in artifacts/killtests/spark-<ad>.json
 * (gitignored; key masked, image bytes replaced by {sha256, bytes}).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadEnvFiles } from '../src/shared/env.js';
import { describeModelConfigForLog, loadModelConfig } from '../src/shared/config.js';
import {
  createModelClient,
  describeImage,
  writeKilltestArtifact,
  type ModelUsage,
} from '../src/server/models/client.js';
import {
  AD_CLAIMS_JSON_SCHEMA,
  buildUserPrompt,
  extractAdClaims,
  ExtractError,
  SYSTEM_PROMPT,
} from '../src/server/models/extract-ad.js';
import { boxIoU } from '../src/shared/geometry.js';
import type { AdClaims } from '../src/shared/schemas.js';
import { loadGroundTruth, type AdGroundTruth } from './ground-truth.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const ADS = ['ad-01-clean', 'ad-02-wrong', 'ad-03-overlap'] as const;
const PANEL_IOU_THRESHOLD = 0.7;

interface FieldCheck {
  field: string;
  pass: boolean;
  detail: string;
}

function fmtUsage(u: ModelUsage | undefined): string {
  if (!u) return 'tokens n/a';
  return `in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'} total=${u.totalTokens ?? '?'}`;
}

function sumUsage(usages: Array<ModelUsage | undefined>): { in: number; out: number; total: number; cost: number | null } {
  let input = 0;
  let output = 0;
  let total = 0;
  let cost: number | null = null;
  for (const u of usages) {
    if (!u) continue;
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    total += u.totalTokens ?? 0;
    if (u.cost !== null) cost = (cost ?? 0) + u.cost;
  }
  return { in: input, out: output, total, cost };
}

function checkAd(ad: string, claims: AdClaims, gt: AdGroundTruth): FieldCheck[] {
  const checks: FieldCheck[] = [];
  const percentOk = claims.discount.percent === gt.discount.percent;
  checks.push({
    field: 'percent',
    pass: percentOk,
    detail: `got ${JSON.stringify(claims.discount.percent)}, want ${gt.discount.percent}`,
  });
  const scopeOk = claims.discount.scope === gt.discount.scope;
  checks.push({
    field: 'scope',
    pass: scopeOk,
    detail: `got ${claims.discount.scope}, want ${gt.discount.scope}`,
  });
  const shippingOk = claims.shipping.terms === gt.shipping;
  checks.push({
    field: 'shipping',
    pass: shippingOk,
    detail: `got ${claims.shipping.terms}, want ${gt.shipping}`,
  });
  const validOk = claims.valid_until.day_month === gt.valid_until;
  checks.push({
    field: 'valid_until',
    pass: validOk,
    detail: `got ${JSON.stringify(claims.valid_until.day_month)}, want ${gt.valid_until}`,
  });
  const iou = claims.panel ? boxIoU({ ...claims.panel.bbox }, { ...gt.panel.bbox }) : 0;
  checks.push({
    field: 'panel IoU>=0.7',
    pass: iou >= PANEL_IOU_THRESHOLD,
    detail: claims.panel ? `IoU=${iou.toFixed(3)} box=${JSON.stringify(claims.panel.bbox)}` : 'no panel reported',
  });
  if (ad === 'ad-01-clean' || ad === 'ad-02-wrong') {
    const opaqueOk = claims.panel?.opaque === gt.panel.opaque;
    checks.push({
      field: 'panel opaque',
      pass: opaqueOk,
      detail: `got ${String(claims.panel?.opaque)}, want ${String(gt.panel.opaque)}`,
    });
  } else {
    checks.push({
      field: 'panel opaque (info)',
      pass: true,
      detail: `got ${String(claims.panel?.opaque)} (alpha 0.92 fixture — judgment call, not scored)`,
    });
  }
  const joined = claims.offer_texts.map((t) => t.text).join('\n');
  const missing = gt.offer_must_contain.filter((w) => !joined.includes(w));
  checks.push({
    field: 'offer words',
    pass: missing.length === 0,
    detail: missing.length === 0 ? `all ${gt.offer_must_contain.length} key words present` : `missing: ${missing.join(' | ')}`,
  });
  const leaked = gt.tagline_forbidden_in_offers.filter((w) => joined.includes(w));
  checks.push({
    field: 'tagline not offer',
    pass: leaked.length === 0,
    detail: leaked.length === 0 ? 'tagline absent from offer_texts' : `leaked into offers: ${leaked.join(' | ')}`,
  });
  return checks;
}

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const config = loadModelConfig(process.env);
  const gt = await loadGroundTruth(REPO_ROOT);
  const client = createModelClient(config);

  console.log('=== Kill test: Hebrew extraction (Spark 1.3) ===');
  console.log(`model=${config.MODEL_EXTRACT} base=${config.MODEL_API_BASE}`);
  const described = describeModelConfigForLog(config);
  console.log(`key=${described['MODEL_API_KEY']}`);
  console.log('Model API only (read-only). Ground truth is local-only, never sent.\n');

  let allPass = true;
  let apiCalls = 0;
  const allUsages: Array<ModelUsage | undefined> = [];

  for (const ad of ADS) {
    const g = gt.ads[ad];
    if (!g) {
      console.log(`${ad}: NO GROUND TRUTH — FAIL`);
      allPass = false;
      continue;
    }
    const imagePath = join(REPO_ROOT, g.file);
    const bytes = await readFile(imagePath);
    const meta = await sharp(bytes).metadata();
    const width = meta.width ?? gt.frame.width;
    const height = meta.height ?? gt.frame.height;

    console.log(`--- ${ad} (${width}x${height}, ${bytes.length} bytes) ---`);
    try {
      const result = await extractAdClaims(client, {
        imageBytes: bytes,
        mimeType: 'image/png',
        width,
        height,
        model: config.MODEL_EXTRACT,
      });
      apiCalls += result.attempts.length;
      for (const a of result.attempts) allUsages.push(a.usage);

      const artifact = {
        test: 'killtest-spark',
        ad,
        ts: new Date().toISOString(),
        model: config.MODEL_EXTRACT,
        image: describeImage(bytes, width, height),
        request: {
          endpoint: 'chat.completions',
          model: config.MODEL_EXTRACT,
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: { name: 'AdClaims', schema: AD_CLAIMS_JSON_SCHEMA, strict: true } },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: buildUserPrompt(width, height, false) },
                { type: 'image_url', image_url: { url: describeImage(bytes, width, height) } },
              ],
            },
          ],
        },
        attempts: result.attempts,
        outputMode: result.outputMode,
        coordSystem: result.coordSystem,
        totalLatencyMs: result.totalLatencyMs,
        claims: result.claims,
      };
      const path = await writeKilltestArtifact(REPO_ROOT, `spark-${ad}.json`, artifact, [config.MODEL_API_KEY]);

      const checks = checkAd(ad, result.claims, g);
      const adPass = checks.every((c) => c.pass);
      allPass = allPass && adPass;
      const usage = sumUsage(result.attempts.map((a) => a.usage));
      console.log(
        `mode=${result.outputMode} coords=${result.coordSystem} latency=${result.totalLatencyMs}ms ` +
          `tokens(in=${usage.in} out=${usage.out} total=${usage.total}) attempts=${result.attempts.length}`,
      );
      for (const c of checks) {
        console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.field}: ${c.detail}`);
      }
      console.log(`  artifact: ${path}`);
      console.log(`  => ${ad}: ${adPass ? 'PASS' : 'FAIL'}\n`);
    } catch (err) {
      allPass = false;
      const attempts = err instanceof ExtractError ? err.attempts : [];
      apiCalls += attempts.length;
      for (const a of attempts) allUsages.push(a.usage);
      await writeKilltestArtifact(
        REPO_ROOT,
        `spark-${ad}.json`,
        {
          test: 'killtest-spark',
          ad,
          ts: new Date().toISOString(),
          model: config.MODEL_EXTRACT,
          image: describeImage(bytes, width, height),
          error: err instanceof Error ? err.message : String(err),
          attempts,
        },
        [config.MODEL_API_KEY],
      );
      console.log(`  [FAIL] extraction error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const total = sumUsage(allUsages);
  console.log(`API calls: ${apiCalls}; tokens: in=${total.in} out=${total.out} total=${total.total}`);
  console.log(`Cost: ${total.cost !== null ? total.cost : '(not reported by API)'}`);
  console.log(allPass ? 'SPARK KILL TEST: ALL PASS' : 'SPARK KILL TEST: FAILURES PRESENT');
  process.exit(allPass ? 0 : 1);
}

await main();
