/**
 * Quality-based fallback ordering (V38, rebalanced V57).
 *
 * The fallback chain used to be ordered by model insertion order — a model
 * added later always landed at the bottom regardless of how good it was. V38
 * replaced that with a catalog score. V57 rebalances it: the old score weighted
 * intelligence_rank × 6, which floated SLOW frontier models (480B/120B) and
 * even DEAD models (a decommissioned model still carrying intelligence_rank=1)
 * to the very top of the chain. Production showed 72% of traffic funnelling
 * into a handful of slow NVIDIA frontier models — 36s avg latency, "operation
 * aborted" the single most common error — while sub-second, 100%-reliable
 * models (groq/sambanova/cohere/mistral 70B-class) sat far down the chain.
 *
 * V57 balances three signals instead of letting capability dominate:
 *
 *   effectiveScore =
 *       qualityScore(catalog)            ← capability: capped intelligence + speed + capacity
 *     + healthPenalty(successPct, n)     ← MEASURED reliability (requests table, 7d)
 *     + latencyPenalty(avgLatencyMs)     ← MEASURED speed       (requests table, 7d)
 *
 * The measured terms are layered in applyQualityOrder (which has DB access);
 * qualityScore stays a pure, unit-testable catalog function. A model with no
 * recent traffic gets neutral measured penalties (0) and is ordered on catalog
 * alone, so freshly-added models are not unfairly buried.
 *
 * intelligence_rank / speed_rank are 1-based, lower = better.
 *
 * After scoring, a provider-diversity pass prevents the same platform from
 * occupying 3+ consecutive slots — otherwise one provider's shared key quota
 * (e.g. NVIDIA's 40 RPM) becomes a chain-wide bottleneck. The pass still
 * respects score order: it only ever picks the best-scored *eligible* model,
 * so diversity never promotes a genuinely worse model past a much better one
 * when no alternative exists.
 */
import type Database from 'better-sqlite3';

export interface ScoredModel {
  modelDbId: number;
  platform: string;
  modelId: string;
  intelligenceRank: number;
  speedRank: number;
  rpmLimit: number | null;
  rpdLimit: number | null;
  isReasoning: number;
  modality: string | null;
  score: number;
}

/**
 * Models that are technically enabled but chronically unreliable under load
 * (verified by stress test) — kept in the catalog so an explicit pin or an
 * idle-time auto-route can still reach them, but forced to the BOTTOM of the
 * enabled text chain so they are only ever tried when everything better is
 * saturated.
 *
 * `@cf/moonshotai/kimi-k2.6` (Cloudflare Workers AI): the 2026-05-29 stress
 * test (scripts/stress-kimi-k26.py) found it returns HTTP 502 Bad Gateway
 * under burst and trips its own cooldown — only 3/50 pinned requests were
 * actually served by it, the rest cascaded to NVIDIA. Demoted (not disabled)
 * per operator decision: "boştayken denensin, dolunca otomatik atlansın".
 */
export const CHRONIC_UNRELIABLE_DEMOTE = new Set<string>([
  '@cf/moonshotai/kimi-k2.6',
]);

/** Additive score for chronically-unreliable models — large enough to pin
 *  them below every healthy enabled model without disabling them. */
const CHRONIC_DEMOTE_PENALTY = 1000;

/** Daily-request-capacity penalty. NULL rpd = uncapped (NVIDIA etc.) → 0. */
function rpdPenalty(rpd: number | null): number {
  if (rpd == null) return 0;
  if (rpd >= 5000) return 0;
  if (rpd >= 1000) return 2;
  if (rpd >= 200) return 5;
  if (rpd >= 50) return 9;
  return 14;
}

/** Per-minute-capacity penalty. NULL rpm = unknown → mild +3. */
function rpmPenalty(rpm: number | null): number {
  if (rpm == null) return 3;
  if (rpm >= 40) return 0;
  if (rpm >= 20) return 2;
  if (rpm >= 10) return 4;
  return 7;
}

/**
 * Catalog capability score (V57). Lower = better.
 *
 * Intelligence is CAPPED at rank 12 then weighted only ×1.0 (was an uncapped
 * ×6). The light weight is deliberate: MEASURED health (0..75) and latency
 * (0..40) must be the dominant axes, with capability a tiebreaker among
 * similarly-healthy models. An early attempt at ×2.5 still let an UNTESTED
 * high-intelligence model (ir=1, no traffic → health/latency both 0) float to
 * priority 1 above a proven 95%-success 0.1s model — exactly the failure we are
 * fixing. At ×1.0 a proven-fast model (capped intelligence 12) beats an
 * untested smart one once the untested model also carries the uncertainty
 * penalty added in applyQualityOrder. speed_rank stays a faint tiebreak (×0.5).
 */
export function qualityScore(m: {
  intelligenceRank: number; speedRank: number;
  rpmLimit: number | null; rpdLimit: number | null; isReasoning: number;
  modelId?: string;
}): number {
  return Math.min(m.intelligenceRank, 12) * 1.0
    + Math.min(m.speedRank, 12) * 0.5
    + rpdPenalty(m.rpdLimit)
    + rpmPenalty(m.rpmLimit)
    + (m.isReasoning ? 4 : 0)
    + (m.modelId && CHRONIC_UNRELIABLE_DEMOTE.has(m.modelId) ? CHRONIC_DEMOTE_PENALTY : 0);
}

/** Minimum request sample before a model's measured success rate is trusted.
 *  Below this, the model is treated as UNTESTED (uncertainty penalty in
 *  applyQualityOrder) rather than scored on catalog intelligence alone — which
 *  otherwise lets a high-"intelligence" but unproven model lead the chain.
 *  Kept low (8) because many good models were previously buried and so have
 *  little traffic; the daily probe + cascade overflow grow the sample over time. */
export const MIN_HEALTH_SAMPLE = 8;

/** Additive penalty for an UNTESTED model (sample < MIN_HEALTH_SAMPLE). Sits it
 *  just below proven-healthy models but well above proven-flaky ones, so it can
 *  still earn traffic under load and accumulate a real health sample. */
export const UNTESTED_PENALTY = 10;

/**
 * MEASURED reliability penalty (V57). Lower = better, so a flaky model gets a
 * large additive penalty that sinks it in the chain.
 *
 *   >=90% → 0      healthy, no penalty
 *   80-90 → +10
 *   65-80 → +28
 *   45-65 → +50
 *    <45  → +75    chronic failure — effectively the bottom of the live chain
 *
 * successPct is 0..100. sampleN guards against tiny samples (see MIN_HEALTH_SAMPLE).
 * The top band (+75) is deliberately below CHRONIC_DEMOTE_PENALTY (1000) so a
 * still-useful-but-flaky model lands under healthy models yet above a
 * known-broken hard-demoted one.
 */
export function healthPenalty(successPct: number | null, sampleN: number): number {
  if (successPct == null || sampleN < MIN_HEALTH_SAMPLE) return 0;
  if (successPct >= 90) return 0;
  if (successPct >= 80) return 10;
  if (successPct >= 65) return 28;
  if (successPct >= 45) return 50;
  return 75;
}

/**
 * MEASURED speed penalty (V57) from average successful-request latency (ms).
 * Lower = better. A model that legitimately answers but takes 30s is a poor
 * default auto-route pick even at 100% success — interactive callers time out.
 * Frontier coding models that need this latency are reached via the explicit
 * `coding` alias, not the general chain.
 *
 *   <1.5s → 0
 *   1.5-4 → +6
 *   4-9   → +16
 *   9-20  → +28
 *   >20s  → +40
 *
 * Null (no measured traffic) → 0 so catalog speed_rank governs instead.
 */
export function latencyPenalty(avgLatencyMs: number | null): number {
  if (avgLatencyMs == null) return 0;
  if (avgLatencyMs < 1500) return 0;
  if (avgLatencyMs < 4000) return 6;
  if (avgLatencyMs < 9000) return 16;
  if (avgLatencyMs < 20000) return 28;
  return 40;
}

/**
 * Provider-diversity pass. Walks the score-sorted list and never lets the
 * same platform fill 3 consecutive slots: when the last two picks share a
 * platform, the next pick is the best-scored model from a *different*
 * platform (falling back to plain score order if none exists).
 */
export function diversify(sorted: ScoredModel[]): ScoredModel[] {
  const pool = [...sorted];
  const result: ScoredModel[] = [];
  while (pool.length > 0) {
    const last2 = result.slice(-2);
    const blocked = last2.length === 2
      && last2[0].platform === last2[1].platform
      ? last2[0].platform
      : null;
    let idx = 0;
    if (blocked) {
      const alt = pool.findIndex(m => m.platform !== blocked);
      if (alt >= 0) idx = alt;
    }
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

/**
 * Quality rank for image-generation models (lower = better).
 *
 * Image models have no intelligence_rank, so quality is keyed off the model
 * family. FLUX (BFL) is the current open-weight SOTA; Midjourney/GPT-image
 * proxies are good but inconsistent; CogView is mid; classic Stable Diffusion
 * (SD 1.5 / SDXL / Dreamshaper) is visibly dated. Within a tier, ordering is
 * stable. Anything unrecognised lands mid-pack (50).
 */
export function imageGenRank(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes('flux-2') || id.includes('flux.2')) return 1;   // real BFL Flux.2
  if (id.includes('flux-pro')) return 2;
  if (id.includes('flux-realism')) return 3;
  if (id.endsWith('/flux') || id.includes('flux-1') || id.includes('flux-schnell') || id.includes('schnell')) return 4;
  if (id.includes('flux-3d') || id.includes('flux-anime') || id.includes('flux')) return 5;
  if (id.includes('midjourney')) return 6;
  if (id.includes('gptimage') || id.includes('gpt-image')) return 7;
  if (id.includes('cogview-3-plus')) return 10;
  if (id.includes('cogview-3-flash')) return 11;
  if (id.includes('cogview')) return 12;
  if (id.includes('turbo')) return 15;
  if (id.includes('dreamshaper')) return 20;
  if (id.includes('sdxl') || id.includes('stable-diffusion-xl')) return 21;
  if (id.includes('stable-diffusion') || id.includes('sd-1.5') || id.includes('sd-v1')) return 22;
  return 50;
}

/**
 * Recompute `fallback_config.priority` for every row.
 *
 * Only ENABLED text rows (modality 'text' or NULL) are scored + diversified
 * and take the top priorities 1..E — the diversity pass must run on exactly
 * the set routing actually traverses, otherwise a disabled model sitting
 * between two same-platform models collapses the gap once routing filters it
 * out (e.g. 4 consecutive NVIDIA models in the effective chain).
 *
 * Disabled text rows are appended next (their priority is irrelevant to
 * routing, which filters `enabled=1`), then non-text rows keep their existing
 * relative order — routing filters by modality so absolute numbers only
 * matter within a modality.
 *
 * Idempotent: running it twice yields the same ordering.
 */
export function applyQualityOrder(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT fc.model_db_id AS modelDbId, fc.priority AS priority,
           m.enabled AS enabled,
           m.platform, m.model_id AS modelId,
           m.intelligence_rank AS intelligenceRank, m.speed_rank AS speedRank,
           m.rpm_limit AS rpmLimit, m.rpd_limit AS rpdLimit,
           m.is_reasoning AS isReasoning, m.modality AS modality
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
  `).all() as Array<ScoredModel & { priority: number; enabled: number }>;

  // MEASURED health + latency over the last 7 days, keyed (platform, model_id).
  // Wrapped in try/catch so a missing/locked requests table (fresh DB, tests
  // with a minimal schema) degrades gracefully to catalog-only ordering.
  const stats = new Map<string, { n: number; successPct: number; avgLatencyMs: number }>();
  try {
    const statRows = db.prepare(`
      SELECT platform, model_id AS modelId,
             COUNT(*) AS n,
             100.0 * SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) / COUNT(*) AS successPct,
             AVG(CASE WHEN status='success' THEN latency_ms END) AS avgLatencyMs
        FROM requests
       WHERE created_at > datetime('now','-7 days')
       GROUP BY platform, model_id
    `).all() as Array<{ platform: string; modelId: string; n: number; successPct: number; avgLatencyMs: number | null }>;
    for (const s of statRows) {
      stats.set(`${s.platform}::${s.modelId}`, {
        n: s.n,
        successPct: s.successPct,
        avgLatencyMs: s.avgLatencyMs ?? 0,
      });
    }
  } catch {
    // no requests table → measured penalties stay 0 (catalog-only ordering)
  }

  const isText = (r: { modality: string | null }) => (r.modality ?? 'text') === 'text';
  const enabledText = rows.filter(r => isText(r) && r.enabled === 1);
  const disabledText = rows.filter(r => isText(r) && r.enabled !== 1);
  const imageRows = rows.filter(r => r.modality === 'image_gen');
  const restRows = rows.filter(r => !isText(r) && r.modality !== 'image_gen');

  for (const r of enabledText) {
    const s = stats.get(`${r.platform}::${r.modelId}`);
    const tested = s != null && s.n >= MIN_HEALTH_SAMPLE;
    const health = tested ? healthPenalty(s!.successPct, s!.n) : 0;
    const lat = tested && s!.avgLatencyMs > 0 ? latencyPenalty(s!.avgLatencyMs) : 0;
    // Untested models (no recent traffic) carry an uncertainty penalty so an
    // unproven high-intelligence model cannot lead the chain over a proven one.
    const uncertainty = tested ? 0 : UNTESTED_PENALTY;
    r.score = qualityScore(r) + health + lat + uncertainty;
  }
  // Stable tie-break: score, then intelligence, then speed, then id.
  enabledText.sort((a, b) =>
    a.score - b.score
    || a.intelligenceRank - b.intelligenceRank
    || a.speedRank - b.speedRank
    || a.modelDbId - b.modelDbId);
  const orderedText = diversify(enabledText);

  // Image-gen rows: sort by family-based quality rank (FLUX first) so
  // auto-route — and the MCP image tool, which shares this chain — picks the
  // best model, not whatever was inserted first. Disabled rows sink.
  imageRows.sort((a, b) =>
    (a.enabled === b.enabled ? 0 : a.enabled === 1 ? -1 : 1)
    || imageGenRank(a.modelId) - imageGenRank(b.modelId)
    || a.modelDbId - b.modelDbId);

  // Disabled text + remaining non-text rows keep their current relative order.
  disabledText.sort((a, b) => a.priority - b.priority);
  restRows.sort((a, b) => a.priority - b.priority);

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const apply = db.transaction(() => {
    let p = 1;
    for (const r of orderedText) update.run(p++, r.modelDbId);
    for (const r of disabledText) update.run(p++, r.modelDbId);
    for (const r of imageRows) update.run(p++, r.modelDbId);
    for (const r of restRows) update.run(p++, r.modelDbId);
  });
  apply();
}
