import crypto from 'crypto';
import { z } from 'zod';
import type { ChatMessage, ChatCompletionResponse, ChatContentPart } from '@myllm/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, setKeyCooldown, classifyError } from '../services/ratelimit.js';
import { getDb } from '../db/index.js';
import { clientCtx } from './clientAuth.js';
import { computeCostMicro } from './pricing.js';

// MAX_RETRIES reduced 20 -> 8 (May 2026). Production analytics showed
// average cascade depth ~5 attempts before success; 20 just buys log spam
// and ~30s extra latency when the entire fallback chain is rate-limited.
// 8 covers the common saturation case without prolonging dead requests.
const MAX_RETRIES = 8;

// ---- Schema (shared with HTTP proxy) ----

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
});

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().refine(
      (u) => u.startsWith('data:image/') || u.startsWith('https://') || u.startsWith('http://'),
      { message: 'image_url.url must be data:image/* or http(s)://' },
    ),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

const contentPartSchema = z.union([textPartSchema, imageUrlPartSchema]);

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(contentPartSchema).min(1)]),
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = typeof msg.content === 'string' && msg.content.length > 0;
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, { message: 'assistant messages must include non-empty content or tool_calls' });

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1) }),
  }),
]);

const responseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().min(1).optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    }),
  }),
]);

export const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: responseFormatSchema.optional(),
  // Caller opt-in to include reasoning-trace models in auto-route.
  // Default: false — reasoning models burn the max_tokens budget on a thinking
  // trace and frequently return content:null with finish_reason=length, which
  // breaks callers expecting an answer. Explicit `model="..."` pins still
  // bypass this gate.
  extra: z.object({
    allow_reasoning: z.boolean().optional(),
  }).optional(),
  // Diagnostic flag (daily health probe): when true and a model is pinned,
  // a failure is NOT cascaded — the pinned model's real error is surfaced.
  // Without this the probe records whatever model the cascade ended on,
  // not the model it meant to test.
  no_cascade: z.boolean().optional(),
  // Diagnostic health-probe flag. When true the request is NOT written to the
  // `requests` analytics table — the daily cron probes every model (including
  // known-dead ones) and those synthetic failures must never pollute real
  // consumer success rates. Routing + cooldown logic still runs (so the probe
  // keeps demoting dead models), only the analytics row is suppressed.
  probe: z.boolean().optional(),
  // OpenAI-compatible end-user identifier. Stored in requests.end_user_id
  // for per-user spend tracking and limit enforcement.
  user: z.string().max(256).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionSchema>;

export function isRetryableError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    // undici throws bare "terminated" / "other side closed" when an upstream
    // SSE connection drops mid-flight (common with NVIDIA on long streams).
    // Retryable so a pre-first-chunk drop cascades to the next key/model.
    || msg.includes('terminated') || msg.includes('other side closed')
    // Context-window overflow — the router's token estimate undershot. Not
    // fixable on this model, but a bigger-window model down the cascade can
    // still take it, so allow the fallback walk to continue.
    || msg.includes('context length') || msg.includes('context window')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    || msg.includes('404') || msg.includes('not found')
    || msg.includes('410') || msg.includes('gone')
    || msg.includes('no longer available') || msg.includes('not available') || msg.includes('decommissioned')
    || msg.includes('502') || msg.includes('bad gateway')
    || msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden');
}

// A provider-specific bad-request: the upstream returned 400/422 on an
// otherwise schema-valid request because THAT model's endpoint rejects a
// feature (observed: NVIDIA phi-4-multimodal 400s on response_format:json).
// Not retryable on the same model, but a DIFFERENT model down the cascade may
// well accept it — so we skip this model and continue rather than letting one
// quirky endpoint sink the whole request with a 502. Only if every cascade
// candidate rejects does the error finally surface.
export function isBadRequestError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('400') || msg.includes('bad request')
      || msg.includes('422') || msg.includes('unprocessable');
}

// A model-level failure: the upstream endpoint itself is unresponsive (hung,
// aborted, connection dropped) rather than a per-key rate limit. When this
// happens the whole model is skipped for the rest of the request — retrying
// its other keys would just burn another full timeout on the same dead
// endpoint (observed: a hung NVIDIA model otherwise eats 6 keys x 45s).
export function isModelLevelFailure(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('terminated') || msg.includes('other side closed')
    || msg.includes('fetch failed') || msg.includes('econnreset')
    || msg.includes('econnrefused') || msg.includes('socket hang');
}

// ---- Sticky session (multi-turn affinity) ----

const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000;

function getSessionKey(messages: ChatMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  const hash = crypto.createHash('sha1').update(firstUser.content).digest('hex');
  return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}

export function getStickyModel(messages: ChatMessage[]): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;
  const key = getSessionKey(messages);
  if (!key) return undefined;
  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// ---- Errors ----

export class ModelNotFoundError extends Error {
  status = 400;
  code = 'model_not_found';
  constructor(modelId: string, disabled: boolean) {
    const reason = disabled ? 'is disabled' : 'is not in the catalog';
    super(`Model '${modelId}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`);
  }
}

export class AllProvidersFailedError extends Error {
  status = 429;
  constructor(public lastMessage: string) {
    super(`All providers rate-limited. Last error: ${lastMessage}`);
  }
}

export class ProviderFatalError extends Error {
  status = 502;
  constructor(public displayName: string, public original: Error) {
    super(`Provider error (${displayName}): ${original.message}`);
  }
}

export class RoutingError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

// ---- Result ----

export interface ChatCompletionRunResult {
  response: ChatCompletionResponse;
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  attempts: number;
  latencyMs: number;
}

// ---- Helpers ----

export function normalizeMessages(parsed: ChatCompletionRequest['messages']): ChatMessage[] {
  return parsed.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }
    return {
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });
}

export function requiresJsonMode(rf: ChatCompletionRequest['response_format']): boolean {
  return rf != null && (rf.type === 'json_object' || rf.type === 'json_schema');
}

export function isMultimodal(messages: ChatMessage[]): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
}

export function countImageParts(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.type === 'image_url') n++;
  }
  return n;
}

function estimateImageTokens(part: Extract<ChatContentPart, { type: 'image_url' }>): number {
  const d = part.image_url.detail ?? 'auto';
  if (d === 'low') return 100;
  if (d === 'high') return 800;
  return 500;
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      n += Math.ceil(m.content.length / 4);
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') n += Math.ceil(p.text.length / 4);
        else if (p.type === 'image_url') n += estimateImageTokens(p);
      }
    }
  }
  return n;
}

// The `coding` alias fallback walk stays inside these providers — never
// leaks to low-quality general models (Reka, etc.) when the prefix is busy.
export const CODING_PLATFORMS = ['nvidia', 'cerebras'];

/**
 * Resolve the fixed `coding` alias chain to model_db_ids, in priority order.
 *
 * Tuned for coding agents: Cerebras qwen-3-235b first — consistently
 * sub-second and rock-solid — then the code-specialist qwen3-coder-480b
 * (NVIDIA) as the next option. deepseek-v4-pro is listed last but is
 * currently disabled in the catalog (the NVIDIA endpoint stalls for
 * minutes); the chain self-heals if a model is disabled. NVIDIA NIM has
 * been intermittently hanging on the big models, so the reliable Cerebras
 * model leads and NVIDIA is the fallback.
 */
export function resolveCodingChain(): number[] {
  const db = getDb();
  const ids = [
    'qwen-3-235b-a22b-instruct-2507',
    'qwen/qwen3-coder-480b-a35b-instruct',
    'deepseek-ai/deepseek-v4-pro',
  ];
  const out: number[] = [];
  for (const modelId of ids) {
    const row = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(modelId) as
      { id: number } | undefined;
    if (row) out.push(row.id);
  }
  return out;
}

/**
 * Resolve the `askpusulasi` alias chain to model_db_ids, in priority order.
 *
 * Tuned for the Aşk Pusulası relationship chatbot: every turn (text OR image —
 * ~1 in 3 messages carries a photo) routes through the SAME vision-capable
 * chain so the persona stays consistent and any turn can accept an image. The
 * order is speed-first, then uncapped capacity, then quality:
 *
 *   1. groq llama-4-scout      — 0.1s, 131K ctx, 4000 req/day. Fastest lead.
 *   2. cloudflare llama-4-scout — 0.4s, 131K ctx, UNCAPPED. Capacity guarantee.
 *   3. nvidia llama-3.2-90b-vision — 0.5s, 131K ctx, UNCAPPED, RPM 40.
 *   4. google gemini-2.5-flash  — 1M ctx, best Turkish nuance. Quality tier.
 *   5. google gemini-2.5-flash-lite — fast 1M-ctx final rung.
 *
 * Resolved by (platform, model_id) because llama-3.2-90b-vision exists on both
 * github (RPM 10) and nvidia (RPM 40) — we want nvidia. All five are
 * vision_capable, json-mode-capable and ≥128K context (long prompts fit).
 *
 * NOTE: unlike `coding`, this alias does NOT restrict platforms — when the
 * prefix saturates the cascade falls through to the full healthy catalog, so a
 * request never 429s for lack of a chain model. For image requests the router's
 * vision filter still keeps every fallback vision-capable.
 */
export function resolveAskpusulasiChain(): number[] {
  const db = getDb();
  const pairs: Array<[string, string]> = [
    ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct'],
    ['nvidia', 'meta/llama-3.2-90b-vision-instruct'],
    ['google', 'gemini-2.5-flash'],
    ['google', 'gemini-2.5-flash-lite'],
  ];
  const out: number[] = [];
  for (const [platform, modelId] of pairs) {
    const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1')
      .get(platform, modelId) as { id: number } | undefined;
    if (row) out.push(row.id);
  }
  return out;
}

export interface ResolvedAlias {
  chain: number[];
  restrictToPlatforms?: string[];
}

/**
 * Map an alias string to its fixed chain + optional platform restriction.
 * Returns null when `requested` is a real model id (or undefined) so the caller
 * falls back to normal pin / auto-route resolution. Centralises alias handling
 * so the sync and streaming proxy paths share one source of truth.
 */
export function resolveAlias(requested: string | undefined): ResolvedAlias | null {
  if (!requested) return null;
  const a = requested.trim().toLowerCase();
  if (['coding', 'code'].includes(a)) {
    return { chain: resolveCodingChain(), restrictToPlatforms: CODING_PLATFORMS };
  }
  if (['askpusulasi', 'ask-pusulasi', 'relationship', 'iliski', 'ilişki'].includes(a)) {
    return { chain: resolveAskpusulasiChain() };
  }
  return null;
}

export function resolvePreferredModel(
  requestedModel: string | undefined,
  messages: ChatMessage[],
  requireVision = false,
  requireJsonMode = false,
  // Explicit pin always wins over the auto-route reasoning gate — caller
  // signaled they want this specific model. excludeReasoning only affects
  // the unpinned (auto-route) path.
  _excludeReasoning = false,
): number | undefined {
  if (!requestedModel) return getStickyModel(messages);
  const db = getDb();
  const row = db.prepare('SELECT id, enabled, vision_capable, supports_json_mode, is_reasoning FROM models WHERE model_id = ?').get(requestedModel) as { id: number; enabled: number; vision_capable: number; supports_json_mode: number; is_reasoning: number } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (requireVision && row.vision_capable !== 1) {
    // Vision payload but user pinned a non-vision model. Drop the pin and
    // let auto-route find a vision-capable model.
    return undefined;
  }
  if (requireJsonMode && (row.supports_json_mode !== 1 || row.is_reasoning === 1)) {
    // Pin doesn't support structured output (or is a reasoning model that
    // would burn the budget on its trace). Drop pin → auto-route picks a
    // json-capable model.
    return undefined;
  }
  return row.id;
}

// Extract a provider HTTP code from "Groq API error 429: ..." style messages.
// Used so the requests row carries upstream_status without each provider
// having to expose it on the thrown Error.
function extractUpstreamStatus(msg: string | null | undefined): number | null {
  if (!msg) return null;
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

export interface LogRequestOpts {
  platform: string;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  errorClass?: string | null;
  upstreamStatus?: number | null;
  attempts?: number;
  hasImage?: boolean;
  responseFormat?: string | null;
  keyId?: number | null;
  requestId?: string | null;
  clientKeyId?: number | null;
  // Modality tagging — defaults to 'text' in INSERT. Image / audio paths MUST
  // pass 'image_gen' / 'image_edit' / 'image_inpaint' / 'audio_stt' so analytics
  // queries can separate text vs image vs audio buckets (otherwise everything
  // gets bucketed as text and the image/audio panels show 0).
  modality?: string | null;
  // End-user attribution (V54).
  endUserId?: string | null;
  // Computed cost in micro-USD (V54). When omitted, computed from pricing lib.
  costMicro?: number;
}

export function logRequest(opts: LogRequestOpts) {
  try {
    const db = getDb();
    const endUserId = opts.endUserId ?? clientCtx.getStore()?.endUserId ?? null;
    const costMicro = opts.costMicro ?? computeCostMicro({
      platform: opts.platform,
      modelId: opts.modelId,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      modality: opts.modality,
    });
    db.prepare(`
      INSERT INTO requests (
        platform, model_id, status, input_tokens, output_tokens, latency_ms,
        error, error_class, upstream_status, attempts, has_image, response_format,
        key_id, request_id, modality, client_key_id, end_user_id, cost_micro
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.platform,
      opts.modelId,
      opts.status,
      opts.inputTokens,
      opts.outputTokens,
      opts.latencyMs,
      opts.error,
      opts.errorClass ?? null,
      opts.upstreamStatus ?? extractUpstreamStatus(opts.error),
      opts.attempts ?? 0,
      opts.hasImage ? 1 : 0,
      opts.responseFormat ?? null,
      opts.keyId ?? null,
      opts.requestId ?? null,
      opts.modality ?? 'text',
      opts.clientKeyId ?? clientCtx.getStore()?.clientKeyId ?? null,
      endUserId,
      costMicro,
    );
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}

export { extractUpstreamStatus };

// ---- Core: non-stream chat completion with cascade ----

export async function runChatCompletion(parsed: ChatCompletionRequest): Promise<ChatCompletionRunResult> {
  const start = Date.now();
  const { model: requestedModel, temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, response_format } = parsed;
  const messages = normalizeMessages(parsed.messages);

  const estimatedInputTokens = estimateMessageTokens(messages);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);
  const requireVision = isMultimodal(messages);
  const requireJsonMode = requiresJsonMode(response_format);
  const responseFormatType = response_format?.type ?? null;
  // Per-request id (lightweight; collisions in DB index OK). Lets us join
  // multiple cascade-attempt rows for the same incoming call when diagnosing.
  const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  // Reasoning models burn the max_tokens budget on a thinking trace and
  // often return content:null with finish_reason=length. For auto-route we
  // exclude them by default. Caller can opt in with extra.allow_reasoning,
  // OR pin a reasoning model explicitly via `model="..."` — pinned id always
  // wins. JSON-mode requests already exclude reasoning (via supports_json_mode
  // gate); the explicit excludeReasoning flag covers the plain-text auto-route.
  const excludeReasoning = !parsed.extra?.allow_reasoning && !requestedModel;

  // Fixed alias chains (`coding`, `askpusulasi`, ...) — a reorder-proof,
  // priority model list. coding stays inside NVIDIA+Cerebras; askpusulasi is a
  // vision-first fast chain that cascades to the full catalog. See resolveAlias.
  const alias = resolveAlias(requestedModel);
  const aliasChain = alias?.chain;
  const aliasPlatforms = alias?.restrictToPlatforms;

  // resolvePreferredModel would throw ModelNotFound on the alias string, so
  // only resolve a real pin when the request is NOT an alias.
  const preferredModel = alias
    ? undefined
    : resolvePreferredModel(requestedModel, messages, requireVision, requireJsonMode);

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: Error | null = null;

  // no_cascade (health probe): only ever try the single resolved route so the
  // caller sees the pinned model's true error instead of a cascade endpoint.
  const maxRetries = parsed.no_cascade ? 1 : MAX_RETRIES;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, requireVision, requireJsonMode, excludeReasoning, 'text', undefined, aliasChain, aliasPlatforms, skipModels.size > 0 ? skipModels : undefined);
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      // Frontier models (intelligence rank ≤ 8 — the 480B/253B-class) take
      // longer than the 15s provider default. 45s covers a healthy prefill
      // while still failing fast off a hung NVIDIA endpoint so the cascade
      // can reach a reliable provider.
      const timeoutMs = route.intelligenceRank <= 8 ? 45000 : undefined;
      const result = await route.provider.chatCompletion(
        route.apiKey, messages, route.modelId,
        { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, response_format, timeoutMs },
      );

      const totalTokens = result.usage?.total_tokens ?? 0;
      recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
      recordSuccess(route.modelDbId);
      setStickyModel(messages, route.modelDbId);

      // Probe requests are diagnostic only — never write them to analytics.
      if (!parsed.probe) logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        hasImage: requireVision,
        responseFormat: responseFormatType,
        keyId: route.keyId,
        requestId: reqId,
      });

      return {
        response: result,
        routedPlatform: route.platform,
        routedModel: route.modelId,
        routedDisplayName: route.displayName,
        attempts: attempt,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      const latency = Date.now() - start;
      const errClass = classifyError(err?.message ?? '');
      // Probe requests are diagnostic only — never write them to analytics.
      if (!parsed.probe) logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'error',
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: errClass,
        attempts: attempt,
        hasImage: requireVision,
        responseFormat: responseFormatType,
        keyId: route.keyId,
        requestId: reqId,
      });

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        const reason = classifyError(err.message);
        if (isModelLevelFailure(err) || reason === 'model_gone') {
          // Endpoint hung/unreachable, OR the model id no longer resolves to a
          // serving endpoint (model_gone) — skip the WHOLE model for this
          // request. Retrying its other keys just burns another full timeout /
          // re-404s. model_gone also writes a 6h cooldown so it stops being
          // tried at all until it (maybe) comes back.
          skipModels.add(route.modelDbId);
          setCooldown(route.platform, route.modelId, route.keyId, reason);
        } else if (reason === 'invalid_key' || reason === 'rate_limit_day') {
          // Account-level errors lock the ENTIRE key, not just this model.
          skipKeys.add(skipId);
          setKeyCooldown(route.platform, route.keyId, reason);
        } else {
          // Minute-burst / unknown stay per-model+key (a different model_id
          // on the same key may still work).
          skipKeys.add(skipId);
          setCooldown(route.platform, route.modelId, route.keyId, reason);
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        // Health probe: surface the pinned model's real error, do not cascade.
        if (parsed.no_cascade) throw new ProviderFatalError(route.displayName, err);
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName} (${reason}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Provider-specific 400/422 — skip THIS model and keep cascading so one
      // quirky endpoint can't sink the request (unless this is a no_cascade probe).
      if (isBadRequestError(err) && !parsed.no_cascade) {
        skipModels.add(route.modelDbId);
        setCooldown(route.platform, route.modelId, route.keyId, 'rate_limit_unknown');
        lastError = err;
        console.log(`[Proxy] 400/422 from ${route.displayName}, skipping model and cascading (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
