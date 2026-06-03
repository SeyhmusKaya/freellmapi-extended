import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  vision_capable: number;
  supports_json_mode: number;
  is_reasoning: number;
  intelligence_rank: number;
  modality?: string | null;
  context_window?: number | null;
  neurons_per_call?: number | null;
  supports_img2img?: number;
  supports_inpainting?: number;
}

export type Modality = 'text' | 'image_gen' | 'audio_stt' | 'audio_tts' | 'embedding' | 'rerank';

// Image-op gate: when image-gen request involves an input image (img2img or
// inpainting), routing must pick a model whose row claims that capability.
export interface ImageOps {
  requireImg2Img?: boolean;
  requireInpainting?: boolean;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  /** 1-based intelligence rank (lower = stronger). Used to give frontier
   *  models a longer HTTP timeout. */
  intelligenceRank: number;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  requireVision = false,
  requireJsonMode = false,
  // When true, reasoning-trace models (is_reasoning=1) are skipped in the
  // fallback walk. Default behaviour for auto-route plain-text requests —
  // these models burn the token budget on thinking and frequently return
  // content:null with finish_reason=length, which breaks downstream parsers.
  // Caller opts in with `extra.allow_reasoning`, or pins the model explicitly.
  excludeReasoning = false,
  // 'text' (default) selects chat-completion models; 'image_gen' selects
  // image generation models. Filter routed to models.modality column.
  modality: Modality = 'text',
  // Image-op gate. Only meaningful when modality='image_gen'. Forces a model
  // that declares supports_img2img or supports_inpainting respectively.
  imageOps?: ImageOps,
  // When set, these model_db_ids are tried FIRST (in the given order), then
  // routing falls through to the full fallback chain. Used by the `coding`
  // alias: prefer the coding models, but still cascade across the whole
  // catalog under burst load instead of 429-ing when the top few are limited.
  priorityPrefix?: number[],
  // When set, only models on these platforms are eligible. The `coding` alias
  // uses it to keep the fallback walk inside NVIDIA + Cerebras and never leak
  // to low-quality general models (Reka, etc.).
  restrictToPlatforms?: string[],
  // model_db_ids to skip entirely for this request — used when a model's
  // upstream endpoint is hung, so the cascade does not waste another full
  // timeout retrying its other keys against the same dead endpoint.
  skipModels?: Set<number>,
): RouteResult {
  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  let sortedChain: Array<{ model_db_id: number; priority: number; enabled: number }> =
    fallbackChain.map(entry => ({
      ...entry,
      effectivePriority: entry.priority + getPenalty(entry.model_db_id),
    })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // priorityPrefix: pull the named models to the front (preserving their
  // given order), keep the rest of the chain behind them as graceful
  // fallback. Cline-style burst traffic can exhaust the top models — the
  // request then continues down the full chain rather than failing.
  if (priorityPrefix && priorityPrefix.length > 0) {
    const prefixSet = new Set(priorityPrefix);
    const prefix = priorityPrefix.map((id, i) => ({ model_db_id: id, priority: i + 1, enabled: 1 }));
    const rest = sortedChain.filter(e => !prefixSet.has(e.model_db_id));
    sortedChain = [...prefix, ...rest];
  }

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;
    if (skipModels?.has(entry.model_db_id)) continue;

    // Get model details. Flags layered: vision (image content present) and
    // json mode (structured-output request). Reasoning models are excluded
    // from JSON mode because their thinking trace burns the token budget.
    const whereParts: string[] = ['id = ?', 'enabled = 1'];
    if (modality === 'image_gen') {
      whereParts.push("modality = 'image_gen'");
      if (imageOps?.requireInpainting) whereParts.push('supports_inpainting = 1');
      else if (imageOps?.requireImg2Img) whereParts.push('supports_img2img = 1');
    } else if (modality === 'audio_stt') {
      whereParts.push("modality = 'audio_stt'");
    } else if (modality === 'audio_tts') {
      whereParts.push("modality = 'audio_tts'");
    } else if (modality === 'embedding') {
      whereParts.push("modality = 'embedding'");
    } else if (modality === 'rerank') {
      whereParts.push("modality = 'rerank'");
    } else {
      // Text/default: filter OUT non-chat rows so /v1/chat/completions can't
      // accidentally pick an image-gen / audio / embedding model.
      whereParts.push("(modality = 'text' OR modality IS NULL)");
    }
    if (requireVision)    whereParts.push('vision_capable = 1');
    if (requireJsonMode)  whereParts.push('supports_json_mode = 1', 'is_reasoning = 0');
    if (excludeReasoning && !requireJsonMode) whereParts.push('is_reasoning = 0');
    const model = db.prepare(
      `SELECT * FROM models WHERE ${whereParts.join(' AND ')}`
    ).get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Platform restriction (coding alias): never leak outside the allowed
    // providers, even when the prefix models are all rate-limited.
    if (restrictToPlatforms && !restrictToPlatforms.includes(model.platform)) continue;

    // Context-window guard: skip a model that can't hold the request. A large
    // coding prompt routed to a small-window model (e.g. Reka Edge 16K) just
    // earns a 400 "maximum context length" — skip it so the cascade reaches a
    // bigger-window model instead of burning a failed call.
    if (modality === 'text' && model.context_window
        && estimatedTokens > model.context_window) {
      continue;
    }

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Get all healthy, enabled keys for this platform. For keyless providers
    // (Pollinations etc.) the api_keys table is intentionally empty; we
    // synthesize a single placeholder row so the rest of the routing logic
    // (round-robin, cooldown by key_id, usage_counters) keeps working with
    // a stable key_id=0 identifier.
    let keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(model.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) {
      if (provider.requiresApiKey) continue;
      keys = [{ id: 0, platform: model.platform, encrypted_key: '', iv: '', auth_tag: '', status: 'healthy', enabled: 1 } as KeyRow];
    }

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      // Check cooldown (from previous 429s)
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);
      // Synthetic keyless rows carry empty ciphertext — skip decrypt.
      const decryptedKey = key.id === 0 ? '' : decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
        intelligenceRank: model.intelligence_rank,
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    roundRobinIndex.set(rrKey, idx);
    
    // We don't explicitly penalize the model here because the fact that we 
    // couldn't find a key means we will naturally move to the next model 
    // in the `sortedChain` for THIS specific request.
  }

  if (requireVision) {
    // Distinguish "no vision-capable model at all" from "all on cooldown".
    // The catalog query returns 0 rows when vision_capable=1 has no matches
    // so we surface a clearer message for the caller.
    const visionCount = (db.prepare('SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND vision_capable = 1').get() as { cnt: number }).cnt;
    if (visionCount === 0) {
      const err = new Error('No vision-capable models enabled. Configure at least one (Gemini, Llama 4, MiniMax M2.5, Kimi K2).') as any;
      err.status = 400;
      throw err;
    }
  }
  if (requireJsonMode) {
    const jsonCount = (db.prepare('SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND supports_json_mode = 1 AND is_reasoning = 0').get() as { cnt: number }).cnt;
    if (jsonCount === 0) {
      const err = new Error('No json-mode-capable models enabled. Configure one (Gemini, Groq Llama, Mistral, GPT-OSS, etc.).') as any;
      err.status = 400;
      throw err;
    }
  }
  if (modality === 'image_gen') {
    if (imageOps?.requireInpainting) {
      const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'image_gen' AND supports_inpainting = 1").get() as { cnt: number }).cnt;
      if (cnt === 0) {
        const err = new Error('No inpainting-capable models enabled (need supports_inpainting=1).') as any;
        err.status = 400;
        throw err;
      }
    } else if (imageOps?.requireImg2Img) {
      const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'image_gen' AND supports_img2img = 1").get() as { cnt: number }).cnt;
      if (cnt === 0) {
        const err = new Error('No img2img-capable models enabled (need supports_img2img=1).') as any;
        err.status = 400;
        throw err;
      }
    } else {
      const imageCount = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'image_gen'").get() as { cnt: number }).cnt;
      if (imageCount === 0) {
        const err = new Error('No image-generation models enabled. Configure at least one (Cloudflare flux-1-schnell, sdxl-lightning, dreamshaper, sdxl-base, etc.).') as any;
        err.status = 400;
        throw err;
      }
    }
  }
  if (modality === 'audio_stt') {
    const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'audio_stt'").get() as { cnt: number }).cnt;
    if (cnt === 0) {
      const err = new Error('No audio-transcription models enabled. Configure at least one (Cloudflare Whisper-large-v3-turbo).') as any;
      err.status = 400;
      throw err;
    }
  }
  if (modality === 'audio_tts') {
    const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'audio_tts'").get() as { cnt: number }).cnt;
    if (cnt === 0) {
      const err = new Error('No text-to-speech models enabled. Configure at least one (Cloudflare @cf/myshell-ai/melotts).') as any;
      err.status = 400;
      throw err;
    }
  }
  if (modality === 'embedding') {
    const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'embedding'").get() as { cnt: number }).cnt;
    if (cnt === 0) {
      const err = new Error('No embedding models enabled. Configure at least one (CF BGE-M3, Google embedding-001, Cohere embed-v3, Mistral mistral-embed, Zhipu embedding-3).') as any;
      err.status = 400;
      throw err;
    }
  }
  if (modality === 'rerank') {
    const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM models WHERE enabled = 1 AND modality = 'rerank'").get() as { cnt: number }).cnt;
    if (cnt === 0) {
      const err = new Error('No rerank models enabled. Configure Cohere rerank-v3.5 / rerank-v4.0-fast / rerank-v4.0-pro.') as any;
      err.status = 400;
      throw err;
    }
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
