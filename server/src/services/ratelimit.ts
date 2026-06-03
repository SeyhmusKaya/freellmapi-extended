/**
 * Rate-limit + cooldown layer.
 *
 * Minute windows live in-memory (RPM/TPM) — restart resets them, which is fine
 * because a minute passes anyway. Daily windows (RPD/TPD) persist in SQLite
 * (`usage_counters`) so a pm2 restart doesn't blow our local enforcement of
 * the provider's per-day cap.
 *
 * Cooldowns persist in SQLite too (`cooldowns`) with a classification:
 *   - rate_limit_minute → ~60s
 *   - rate_limit_day    → until next UTC midnight
 *   - rate_limit_unknown→ 5 min
 *   - invalid_key       → 1 hour (give operator time to notice)
 */

import { getDb } from '../db/index.js';

interface MinuteWindow {
  timestamps: number[];
  tokenTimestamps: { ts: number; tokens: number }[];
}

const minuteWindows = new Map<string, MinuteWindow>();

function getMinuteWindow(key: string): MinuteWindow {
  let w = minuteWindows.get(key);
  if (!w) {
    w = { timestamps: [], tokenTimestamps: [] };
    minuteWindows.set(key, w);
  }
  return w;
}

const MINUTE = 60 * 1000;

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function nextUtcMidnightIso(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function readDailyCounter(platform: string, modelId: string, keyId: number): { requests: number; tokens: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT requests, tokens FROM usage_counters
     WHERE platform=? AND model_id=? AND key_id=? AND window_start=?
  `).get(platform, modelId, keyId, utcDay()) as { requests: number; tokens: number } | undefined;
  return row ?? { requests: 0, tokens: 0 };
}

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  if (limits.rpm !== null) {
    const w = getMinuteWindow(`${platform}:${modelId}:${keyId}:rpm`);
    w.timestamps = w.timestamps.filter(ts => ts > now - MINUTE);
    if (w.timestamps.length >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    const { requests } = readDailyCounter(platform, modelId, keyId);
    if (requests >= limits.rpd) return false;
  }

  return true;
}

export function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  if (limits.tpm !== null) {
    const w = getMinuteWindow(`${platform}:${modelId}:${keyId}:tpm`);
    w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - MINUTE);
    const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const { tokens } = readDailyCounter(platform, modelId, keyId);
    if (tokens + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  getMinuteWindow(`${platform}:${modelId}:${keyId}:rpm`).timestamps.push(now);

  // Daily counter is persisted.
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO usage_counters (platform, model_id, key_id, window_start, requests, tokens)
      VALUES (?, ?, ?, ?, 1, 0)
      ON CONFLICT(platform, model_id, key_id, window_start) DO UPDATE
         SET requests = requests + 1
    `).run(platform, modelId, keyId, utcDay(now));
  } catch (e) {
    console.error('[Rate] recordRequest persist failed:', e);
  }
}

export function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  if (!tokens) return;
  const now = Date.now();

  getMinuteWindow(`${platform}:${modelId}:${keyId}:tpm`).tokenTimestamps.push({ ts: now, tokens });

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO usage_counters (platform, model_id, key_id, window_start, requests, tokens)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(platform, model_id, key_id, window_start) DO UPDATE
         SET tokens = tokens + excluded.tokens
    `).run(platform, modelId, keyId, utcDay(now), tokens);
  } catch (e) {
    console.error('[Rate] recordTokens persist failed:', e);
  }
}

// ---- Cooldowns (classified) ----

export type CooldownReason = 'rate_limit_minute' | 'rate_limit_day' | 'rate_limit_unknown' | 'invalid_key' | 'model_gone';

/**
 * Classify a provider error message to pick the right cooldown.
 *
 * Heuristic — providers don't have a unified vocabulary. We look for explicit
 * daily-quota words first (Google's `free_tier_requests` quota → "Quota
 * exceeded for ... per day"; Mistral's "tokens per day"; OpenRouter's "rate
 * limit ... per day"). Then short minute-burst markers. Else unknown.
 */
export function classifyError(message: string): CooldownReason {
  const m = (message ?? '').toLowerCase();
  // True auth failures (wrong/revoked key) — short 1h cooldown gives an
  // operator time to notice and rotate; retrying just spams the log.
  if (m.includes('401') || m.includes('403') || m.includes('unauthorized') || m.includes('forbidden') || m.includes('invalid api key')) {
    return 'invalid_key';
  }
  // Dead route — the model id no longer resolves to any serving endpoint.
  // Distinct from a rate limit: retrying inside a 5-min "unknown" window just
  // re-404s forever and wastes a cascade slot. Cool down for 6h so a model that
  // is genuinely gone stops being tried, while a provider that flaps under load
  // (OpenRouter :free pool, Cerebras free tier) still recovers within the day.
  // "no endpoints found" (OpenRouter), "decommissioned"/"no longer available"
  // (catalog drift), and a bare 404 Not Found all land here.
  if (m.includes('no endpoints found') || m.includes('decommissioned')
      || m.includes('no longer available') || m.includes('model_not_found')
      || m.includes('model not found')
      || ((m.includes('404') || m.includes('not found')) && !m.includes('per day') && !m.includes('per minute'))) {
    return 'model_gone';
  }
  // Day-bucket exhaustion — billing/wallet drained, daily quota hit, free
  // tier monthly cap, account-level credit gone. Retrying inside the day
  // cannot succeed; cool down until UTC midnight (or 24h, whichever is sooner).
  if (m.includes('insufficient balance') || m.includes('402')
      || m.includes('out of credits') || m.includes('credits exhausted')
      || m.includes('per day') || m.includes('per-day') || m.includes('daily') || m.includes('per_day')
      || m.includes('rpd') || m.includes('tpd') || m.includes('free_tier_requests')
      || m.includes('quota exceeded') || m.includes('exceeded your current quota')
      || m.includes('resource_exhausted') || m.includes('account')
      // Zhipu returns balance/quota exhaustion in Chinese: "余额不足或无可用资源包"
      // (insufficient balance / no resource pack available). lowercase() does
      // not affect CJK, so match the raw substrings here.
      || m.includes('余额不足') || m.includes('无可用资源包')) {
    return 'rate_limit_day';
  }
  // Minute-bucket — short retry window. Includes the generic OpenRouter
  // "Provider returned error" body (mostly observed wrapped in HTTP 429
  // upstream-burst rejections).
  if (m.includes('per minute') || m.includes('per-minute') || m.includes('rpm') || m.includes('tpm')
      || m.includes('too many requests') || m.includes('rate limit') || m.includes('429')
      || m.includes('provider returned error')) {
    return 'rate_limit_minute';
  }
  return 'rate_limit_unknown';
}

// Errors that should NOT trigger any cooldown — they're 4xx user errors
// that the provider would return again on retry (bad prompt, malformed
// JSON, dimension mismatch). Caller decides whether to surface to client
// or just log. Distinct from retryable: we don't even want to skip the
// key/model for this request.
export function isClientFault(message: string): boolean {
  const m = (message ?? '').toLowerCase();
  return m.includes('failed to validate json')
      || m.includes('failed to generate json')
      || m.includes('invalid or incomplete input')
      || m.includes('unexpected shape for input')
      || m.includes('input tensor')
      || m.includes('unsupported image format');
}

// SHORT_FALLBACK_MS bumped 60s -> 180s (May 2026). OpenRouter free-tier 429s
// come back continuously inside a 60s window; cycling back to the same model
// too fast wastes a cascade slot. 3min lets the upstream window actually
// reset before we retry. Day-bucket reset (Google daily quota) is computed
// separately (nextUtcMidnightIso) so it's not affected.
const SHORT_FALLBACK_MS = 3 * 60 * 1000;
const UNKNOWN_FALLBACK_MS = 5 * 60 * 1000;
const INVALID_KEY_MS = 60 * 60 * 1000;
// Dead-route cooldown — long enough to stop hammering a gone model, short
// enough that a load-flapping free-tier model rejoins within the day.
const MODEL_GONE_MS = 6 * 60 * 60 * 1000;

export function setCooldown(
  platform: string,
  modelId: string,
  keyId: number,
  durationMsOrReason?: number | CooldownReason,
  reason?: CooldownReason,
) {
  let expiresAtIso: string;
  let actualReason: CooldownReason;

  if (typeof durationMsOrReason === 'string') {
    actualReason = durationMsOrReason;
    expiresAtIso = computeExpiry(actualReason);
  } else {
    actualReason = reason ?? 'rate_limit_unknown';
    if (durationMsOrReason && Number.isFinite(durationMsOrReason)) {
      const d = new Date(Date.now() + durationMsOrReason);
      expiresAtIso = d.toISOString().replace('T', ' ').slice(0, 19);
    } else {
      expiresAtIso = computeExpiry(actualReason);
    }
  }

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO cooldowns (platform, model_id, key_id, expires_at, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id) DO UPDATE
         SET expires_at = excluded.expires_at,
             reason = excluded.reason
    `).run(platform, modelId, keyId, expiresAtIso, actualReason);
  } catch (e) {
    console.error('[Rate] setCooldown persist failed:', e);
  }
}

/**
 * Key-wide cooldown: locks ALL models on a single (platform, key_id) pair.
 * Uses model_id='*' as a wildcard sentinel that isOnCooldown also checks.
 *
 * Use when the upstream signal is account-level rather than model-level:
 *   - invalid_key       (revoked / wrong key)
 *   - rate_limit_day    (insufficient balance, account quota exhausted)
 *
 * Calling setCooldown(p, modelId, k, reason) instead would only block the
 * one model_id on that key — the next model_id in the cascade would hit
 * the same dead key and re-fail.
 */
export function setKeyCooldown(platform: string, keyId: number, reason: CooldownReason) {
  const expiresAtIso = computeExpiry(reason);
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO cooldowns (platform, model_id, key_id, expires_at, reason)
      VALUES (?, '*', ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id) DO UPDATE
         SET expires_at = excluded.expires_at,
             reason = excluded.reason
    `).run(platform, keyId, expiresAtIso, reason);
  } catch (e) {
    console.error('[Rate] setKeyCooldown persist failed:', e);
  }
}

function computeExpiry(reason: CooldownReason): string {
  if (reason === 'rate_limit_day') return nextUtcMidnightIso();
  if (reason === 'model_gone') {
    const d = new Date(Date.now() + MODEL_GONE_MS);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (reason === 'invalid_key') {
    const d = new Date(Date.now() + INVALID_KEY_MS);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (reason === 'rate_limit_unknown') {
    const d = new Date(Date.now() + UNKNOWN_FALLBACK_MS);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  const d = new Date(Date.now() + SHORT_FALLBACK_MS);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── Half-open circuit breaker ──────────────────────────────────────────
// When a KEY-WIDE cooldown ('*') expires, every queued request rushes the
// just-recovered key at once. If the key is still bad they all fail before
// the first one re-writes the cooldown (the classic "thundering herd" — see
// the DeepSeek 402 burst). After an expired '*' row is cleared, the first
// caller becomes the sole "prober" and holds an in-memory lease; other
// callers are kept on cooldown until the lease expires. If the prober's call
// fails it re-writes the DB cooldown (herd stays blocked); if it succeeds the
// lease lapses and the key fully reopens. Lease is short so a healthy key is
// only briefly over-blocked — the cascade serves those requests elsewhere.
const HALF_OPEN_LEASE_MS = 8_000;
const keyHalfOpenLease = new Map<string, number>(); // "platform:keyId" -> lease-expiry ms

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  try {
    const db = getDb();
    // Check BOTH model-specific row AND key-wide wildcard '*' row. A row
    // with model_id='*' (set by setKeyCooldown) shadows ALL models on that
    // key for the cooldown duration. Earliest non-expired row wins.
    const rows = db.prepare(`
      SELECT model_id, expires_at FROM cooldowns
       WHERE platform=? AND key_id=? AND (model_id=? OR model_id='*')
    `).all(platform, keyId, modelId) as Array<{ model_id: string; expires_at: string }>;
    if (!rows.length) return false;
    const now = Date.now();
    let active = false;
    for (const row of rows) {
      const expiry = new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime();
      if (Number.isNaN(expiry)) continue;
      if (now > expiry) {
        // Stale row - delete it
        db.prepare('DELETE FROM cooldowns WHERE platform=? AND model_id=? AND key_id=?').run(platform, row.model_id, keyId);
        // Key-wide cooldown just expired → half-open: only the first caller
        // (the prober) gets through; hold the rest until the lease lapses.
        if (row.model_id === '*') {
          const leaseKey = `${platform}:${keyId}`;
          const lease = keyHalfOpenLease.get(leaseKey);
          if (lease && now < lease) {
            active = true; // another prober holds the lease — stay blocked
          } else {
            keyHalfOpenLease.set(leaseKey, now + HALF_OPEN_LEASE_MS);
          }
        }
      } else {
        active = true;
      }
    }
    return active;
  } catch {
    return false;
  }
}

export function getCooldownDetail(platform: string, modelId: string, keyId: number): { expiresAt: string; reason: string } | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT expires_at, reason FROM cooldowns
       WHERE platform=? AND model_id=? AND key_id=?
    `).get(platform, modelId, keyId) as { expires_at: string; reason: string } | undefined;
    if (!row) return null;
    const expiry = new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime();
    if (Number.isNaN(expiry) || Date.now() > expiry) return null;
    return { expiresAt: row.expires_at, reason: row.reason };
  } catch {
    return null;
  }
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  const rpmW = getMinuteWindow(`${platform}:${modelId}:${keyId}:rpm`);
  rpmW.timestamps = rpmW.timestamps.filter(ts => ts > now - MINUTE);

  const tpmW = getMinuteWindow(`${platform}:${modelId}:${keyId}:tpm`);
  tpmW.tokenTimestamps = tpmW.tokenTimestamps.filter(t => t.ts > now - MINUTE);
  const tpmUsed = tpmW.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);

  const daily = readDailyCounter(platform, modelId, keyId);

  return {
    rpm: { used: rpmW.timestamps.length, limit: limits.rpm },
    rpd: { used: daily.requests, limit: limits.rpd },
    tpm: { used: tpmUsed, limit: limits.tpm },
    tpd: { used: daily.tokens, limit: limits.tpd },
  };
}
