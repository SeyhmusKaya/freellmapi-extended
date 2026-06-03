import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const analyticsRouter = Router();

// Map range to a JS-computed ISO timestamp passed as a bind parameter,
// so the SQL string never includes user-controlled fragments.
function getSinceTimestamp(range: string): string {
  const now = Date.now();
  switch (range) {
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case '7d':
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

// Cost-savings baseline (per 1M tokens). Set to Gemini 3.1 Flash-Lite — the
// cheapest paid model we'd realistically swap to — so "savings" is a
// conservative, honest figure (what the same traffic would cost on the cheapest
// alternative) rather than an inflated GPT-4o comparison. Text only: image-gen
// rows record neuron counts in output_tokens, not real tokens, so they're
// excluded and counted separately at SAVINGS_PER_IMAGE.
const SAVINGS_INPUT_PER_1M = 0.25;   // Gemini 3.1 Flash-Lite input
const SAVINGS_OUTPUT_PER_1M = 1.50;  // Gemini 3.1 Flash-Lite output
const SAVINGS_PER_IMAGE = 0.04;      // DALL-E 3 standard equivalent

// Summary stats. Cost-savings uses the SAVINGS_* baseline above (Gemini 3.1
// Flash-Lite token pricing), meaningful for TEXT only. Images come back as
// their own counter (`imagesGenerated`) plus a per-image dollar estimate.
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  // Token totals MUST filter status='success'. Error rows store
  // `inputTokens: estimatedInputTokens` for diagnostic value (see runChat-
  // Completion.ts logRequest call in the catch block). A single user request
  // that cascades through N providers writes N error rows with the same
  // estimated input — counting them inflates input_tokens N-fold. Fallback
  // page (routes/fallback.ts) correctly filters to success rows; analytics
  // must do the same so the two views agree.
  const textStats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END) as total_input_tokens,
      SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) as total_output_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM requests
    WHERE created_at >= ?
      AND (modality = 'text' OR modality IS NULL)
  `).get(since) as any;

  const imageStats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      AVG(latency_ms) as avg_latency_ms
    FROM requests
    WHERE created_at >= ?
      AND modality IN ('image_gen','image_edit','image_inpaint')
  `).get(since) as any;

  // V30/V32/V34 — additional modality counters (embedding/audio_tts/audio_stt/
  // rerank). Each is reported as success count so the UI can show calls/day.
  const auxStats = db.prepare(`
    SELECT modality,
           COUNT(*) AS total_requests,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count
      FROM requests
     WHERE created_at >= ?
       AND modality IN ('embedding','audio_tts','audio_stt','rerank')
     GROUP BY modality
  `).all(since) as Array<{ modality: string; total_requests: number; success_count: number }>;
  const auxMap = new Map(auxStats.map(r => [r.modality, r]));
  const embeddingCount = auxMap.get('embedding')?.success_count ?? 0;
  const ttsCount = auxMap.get('audio_tts')?.success_count ?? 0;
  const sttCount = auxMap.get('audio_stt')?.success_count ?? 0;
  const rerankCount = auxMap.get('rerank')?.success_count ?? 0;

  // REQUEST-LEVEL totals (collapse cascade attempts of one call into one
  // logical request). successRate then reflects what the CALLER experienced,
  // not per-attempt rows; cascadeRetries surfaces the recovered fallback work.
  const reqStats = db.prepare(`
    SELECT
      COUNT(*)            AS requests,
      SUM(succeeded)      AS success,
      SUM(cascade_rows)   AS cascade
    FROM (
      SELECT
        COALESCE(request_id, 'id:' || id) AS rk,
        MAX(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
        CASE WHEN MAX(CASE WHEN status='success' THEN 1 ELSE 0 END) = 1
             THEN SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) ELSE 0 END AS cascade_rows
      FROM requests
      WHERE created_at >= ?
      GROUP BY rk
    )
  `).get(since) as any;

  const totalRequests = reqStats.requests ?? 0;
  const successCount = reqStats.success ?? 0;
  const cascadeRetries = reqStats.cascade ?? 0;
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;

  // Latency — a single count-weighted average over EVERY request in range.
  // The old code averaged the text-mean and image-mean (mean-of-means),
  // which ignored request-count weighting and dropped aux modalities
  // entirely; 1000 fast text reqs + 2 slow image reqs reported the slow one.
  const latencyStat = db.prepare(`
    SELECT AVG(latency_ms) AS avg_latency_ms
    FROM requests
    WHERE created_at >= ? AND latency_ms IS NOT NULL
  `).get(since) as any;

  // Cost-savings — TEXT only. Baseline = Gemini 3.1 Flash-Lite token pricing.
  const inputCost = ((textStats.total_input_tokens ?? 0) / 1_000_000) * SAVINGS_INPUT_PER_1M;
  const outputCost = ((textStats.total_output_tokens ?? 0) / 1_000_000) * SAVINGS_OUTPUT_PER_1M;
  // Image-gen savings — DALL-E 3 standard ~$0.04/image. Conservative.
  const imageSavings = (imageStats.success_count ?? 0) * SAVINGS_PER_IMAGE;

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    cascadeRetries,
    totalInputTokens: textStats.total_input_tokens ?? 0,
    totalOutputTokens: textStats.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(latencyStat.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((inputCost + outputCost + imageSavings) * 100) / 100,
    // New: image counters surfaced separately so the UI can render them
    // alongside the token totals without conflating units.
    imagesGenerated: imageStats.success_count ?? 0,
    imageRequests: imageStats.total_requests ?? 0,
    // V30/V32/V34 — extra modality counters (success rows only).
    embeddingsGenerated: embeddingCount,
    ttsGenerated: ttsCount,
    sttTranscribed: sttCount,
    reranksPerformed: rerankCount,
  });
});

// Stats grouped by model
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COALESCE(m.modality, 'text') AS modality,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      -- token totals from success rows only (errors store estimated input_tokens
      -- for diagnostics; counting them inflates totals N-fold across cascade)
      SUM(CASE WHEN r.status='success' THEN r.input_tokens ELSE 0 END) as total_input_tokens,
      SUM(CASE WHEN r.status='success' THEN r.output_tokens ELSE 0 END) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    modality: r.modality ?? 'text',
    requests: r.requests,
    successCount: r.success_count ?? 0,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    // For image rows, totalOutputTokens stores neurons used (we keep the
    // shape consistent, UI labels it differently when modality !== 'text').
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Stats grouped by platform
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      -- success-only token totals to match fallback page semantics
      SUM(CASE WHEN r.status='success' THEN r.input_tokens ELSE 0 END) as total_input_tokens,
      SUM(CASE WHEN r.status='success' THEN r.output_tokens ELSE 0 END) as total_output_tokens,
      SUM(CASE WHEN r.modality IN ('image_gen','image_edit','image_inpaint') THEN 1 ELSE 0 END) AS image_requests,
      SUM(CASE WHEN r.modality IN ('image_gen','image_edit','image_inpaint') AND r.status='success' THEN 1 ELSE 0 END) AS images_generated
    FROM requests r
    WHERE r.created_at >= ?
    GROUP BY r.platform
    ORDER BY requests DESC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    requests: r.requests,
    successCount: r.success_count ?? 0,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    imageRequests: r.image_requests ?? 0,
    imagesGenerated: r.images_generated ?? 0,
  })));
});

// Timeline data
analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  // dateFormat is a hardcoded whitelist — never user-controlled.
  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', created_at) as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests
    WHERE created_at >= ?
    GROUP BY strftime('${dateFormat}', created_at)
    ORDER BY timestamp ASC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
  })));
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  // Group errors by category (extract the key part of the error message)
  const rows = db.prepare(`
    SELECT
      platform,
      model_id,
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform, error_category
    ORDER BY count DESC
  `).all(since) as any[];

  // Also get totals by category
  const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY category
    ORDER BY count DESC
  `).all(since) as any[];

  // Errors by platform
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform
    ORDER BY count DESC
  `).all(since) as any[];

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

// Recent errors
analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(since) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
});

/**
 * Per-client-key usage breakdown. Lets the operator see "which project burned
 * what" — a request authenticated with client_key=N is attributed to N here.
 * Rows with NULL client_key_id (pre-V45 traffic, before per-key attribution
 * existed) bucket into a synthetic "Bilinmeyen" row so totals still match.
 */
analyticsRouter.get('/by-key', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  // REQUEST-LEVEL aggregation. A single incoming API call can write many rows
  // (one per cascade attempt) sharing the same request_id. We collapse those to
  // one logical request first, so:
  //   - error_count  = requests that NEVER succeeded (real user-facing failures)
  //   - cascade_count= failed attempts on requests that DID succeed (recovered
  //                    retries the caller never saw)
  // Rows with a NULL request_id (legacy/unlabelled) are treated as their own
  // request via COALESCE(request_id,'id:'||id) so old data still aggregates.
  const rows = db.prepare(`
    SELECT
      t.client_key_id                                AS client_key_id,
      COALESCE(ck.name, 'Unknown')                   AS name,
      COUNT(*)                                       AS total_requests,
      SUM(t.succeeded)                               AS success_count,
      SUM(1 - t.succeeded)                           AS error_count,
      SUM(t.cascade_rows)                            AS cascade_count,
      SUM(t.in_tok)                                  AS total_input_tokens,
      SUM(t.out_tok)                                 AS total_output_tokens,
      AVG(t.lat)                                     AS avg_latency_ms,
      SUM(t.img)                                     AS images_generated,
      SUM(t.cost)                                    AS cost_micro
    FROM (
      SELECT
        COALESCE(r.request_id, 'id:' || r.id)                                AS rk,
        r.client_key_id                                                      AS client_key_id,
        MAX(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END)                AS succeeded,
        CASE WHEN MAX(CASE WHEN r.status='success' THEN 1 ELSE 0 END) = 1
             THEN SUM(CASE WHEN r.status='error' THEN 1 ELSE 0 END) ELSE 0 END AS cascade_rows,
        SUM(CASE WHEN r.status = 'success' THEN r.input_tokens  ELSE 0 END)  AS in_tok,
        SUM(CASE WHEN r.status = 'success' THEN r.output_tokens ELSE 0 END)  AS out_tok,
        COALESCE(MAX(CASE WHEN r.status='success' THEN r.latency_ms END), MAX(r.latency_ms)) AS lat,
        MAX(CASE WHEN r.status='success' AND r.modality IN ('image_gen','image_edit','image_inpaint')
                 THEN 1 ELSE 0 END)                                          AS img,
        SUM(CASE WHEN r.status = 'success' THEN COALESCE(r.cost_micro, 0) ELSE 0 END) AS cost
      FROM requests r
      WHERE r.created_at >= ?
      GROUP BY rk, r.client_key_id
    ) t
    LEFT JOIN client_keys ck ON ck.id = t.client_key_id
    GROUP BY t.client_key_id, ck.name
    ORDER BY total_requests DESC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    clientKeyId: r.client_key_id,
    name: r.name,
    totalRequests: r.total_requests,
    successCount: r.success_count,
    errorCount: r.error_count,
    cascadeCount: r.cascade_count ?? 0,
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
    imagesGenerated: r.images_generated ?? 0,
    // micro-USD → USD for the dashboard cost column
    costUsd: Math.round(((r.cost_micro ?? 0) / 1_000_000) * 100) / 100,
  })));
});

// Reset analytics for a window — deletes the `requests` rows the chosen range
// displays (default 24h). Behind the dashboard Basic Auth (nginx). Used to
// clear probe / test noise and start a fresh measurement window.
//
// Scope: ONLY the requests table (the analytics source). usage_counters and
// cooldowns are left intact so deleting analytics rows can never relax a real
// provider daily cap or revive a cooled-down dead key.
analyticsRouter.post('/reset', (req: Request, res: Response) => {
  const range = (req.body?.range as string) ?? '24h';
  if (!['24h', '7d', '30d'].includes(range)) {
    res.status(400).json({ error: { message: 'range must be 24h | 7d | 30d', type: 'invalid_request_error' } });
    return;
  }
  const since = getSinceTimestamp(range);
  const db = getDb();
  const info = db.prepare('DELETE FROM requests WHERE created_at >= ?').run(since);
  res.json({ deleted: info.changes, range, since });
});
