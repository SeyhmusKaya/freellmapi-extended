import { z } from 'zod';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, setKeyCooldown, classifyError } from '../services/ratelimit.js';
import { getDb } from '../db/index.js';
import {
  AllProvidersFailedError,
  ModelNotFoundError,
  ProviderFatalError,
  RoutingError,
  logRequest,
  isRetryableError,
} from './runChatCompletion.js';
import type { EmbedResult } from '../providers/base.js';
import { ResultCache, hashKey } from './resultCache.js';

// Embeddings are deterministic for a given (model, input) — cache them so a
// repeated call (common in RAG: re-indexing the same documents) is served
// locally instead of spending free-tier quota. Only small requests are cached
// (large batches would bloat memory and are rarely repeated verbatim).
const EMBED_CACHE_MAX_INPUTS = 32;
const embedCache = new ResultCache<EmbeddingRunResult>(500, 60 * 60 * 1000);

/**
 * /v1/embeddings core. Same cascade-router pattern as runChatCompletion +
 * runImageGeneration: pick highest-priority embedding model -> call provider
 * -> on retryable error mark cooldown + cascade to next.
 */

const MAX_RETRIES = 6;

// Known embedding-vector dimensions per catalog model_id. Used to keep an
// auto-route fallback dimension-consistent with a pinned model: a caller who
// pins a 1024-dim model must not silently receive 3072-dim vectors from a
// fallback (e.g. GitHub text-embedding-3-large), which corrupts their index.
// Models absent from this map have unknown dim and are allowed — the
// post-call dimension check is the backstop for those.
const EMBED_DIMS: Record<string, number> = {
  '@cf/baai/bge-m3': 1024,
  '@cf/baai/bge-large-en-v1.5': 1024,
  '@cf/baai/bge-base-en-v1.5': 768,
  '@cf/baai/bge-small-en-v1.5': 384,
  'baai/bge-m3': 1024,
  'gemini-embedding-001': 768,
  'embed-multilingual-v3.0': 1024,
  'embed-english-v3.0': 1024,
  'embed-v4.0': 1536,
  'embedding-3': 1024,
  'embedding-2': 1024,
  'openai/text-embedding-3-large': 3072,
  'openai/text-embedding-3-small': 1536,
  'nvidia/llama-3.2-nv-embedqa-1b-v1': 2048,
  'nvidia/llama-nemotron-embed-1b-v2': 2048,
};
// Max inputs per single OpenAI /v1/embeddings call; providers vary (Cohere
// allows 96, Google batchEmbedContents 100, CF accepts arbitrary, Mistral
// 1024). We cap client-side at 96 to stay safe across all upstreams. Beyond
// this we chunk internally.
const MAX_BATCH_PER_CALL = 96;

const inputSchema = z.union([
  z.string().min(1).max(8192),
  z.array(z.string().min(1).max(8192)).min(1).max(2048),
]);

export const embeddingSchema = z.object({
  model: z.string().optional(),
  input: inputSchema,
  dimensions: z.number().int().min(64).max(4096).optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  input_type: z.enum(['search_document', 'search_query', 'classification', 'clustering']).optional(),
  user: z.string().optional(),
});

export type EmbeddingRequest = z.infer<typeof embeddingSchema>;

export interface EmbeddingRunResult {
  vectors: number[][];
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  promptTokens: number;
  dimensions: number;
  attempts: number;
  latencyMs: number;
}

function resolveEmbeddingModel(
  requestedModel: string | undefined,
): { id: number; modelId: string } | undefined {
  if (!requestedModel) return undefined;
  const db = getDb();
  const row = (db.prepare('SELECT id, model_id, enabled, modality FROM models WHERE model_id = ?').get(requestedModel)
    ?? db.prepare("SELECT id, model_id, enabled, modality FROM models WHERE model_id LIKE ?").get(`%/${requestedModel}`)) as
      { id: number; model_id: string; enabled: number; modality: string | null } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (row.modality !== 'embedding') return undefined;
  return { id: row.id, modelId: row.model_id };
}

export async function runEmbedding(parsed: EmbeddingRequest): Promise<EmbeddingRunResult> {
  const start = Date.now();
  const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
  const preferred = resolveEmbeddingModel(parsed.model);
  const preferredModel = preferred?.id;
  // When a caller pins a model with a known dimension, every fallback must
  // match it — otherwise auto-route would silently mix vector sizes.
  const targetDim = preferred ? EMBED_DIMS[preferred.modelId] : undefined;
  const reqId = `embed_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  // Rough neuron estimate: 1 per input + tail for long strings. Real
  // accounting happens after the upstream returns prompt_tokens.
  const estimatedNeurons = inputs.length * 2;

  // Cache lookup — only for small requests. Key includes model + the params
  // that change the vector, so a hit is identical to a live call.
  const cacheable = inputs.length <= EMBED_CACHE_MAX_INPUTS;
  const cacheKey = cacheable
    ? hashKey('embed', parsed.model ?? 'auto', parsed.dimensions ?? 0, parsed.input_type ?? '', inputs)
    : '';
  if (cacheable) {
    const hit = embedCache.get(cacheKey);
    if (hit) return { ...hit, attempts: 0, latencyMs: Date.now() - start };
  }

  const skipKeys = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedNeurons, skipKeys.size > 0 ? skipKeys : undefined, preferredModel,
        false, false, false, 'embedding');
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    // Pinned-model dim guard: skip a known-mismatched fallback before we
    // spend a call on it.
    if (targetDim !== undefined) {
      const routeDim = EMBED_DIMS[route.modelId];
      if (routeDim !== undefined && routeDim !== targetDim) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        lastError = new Error(`skipped ${route.modelId}: ${routeDim}-dim != pinned ${targetDim}-dim`);
        continue;
      }
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      // Chunk if caller submitted more than MAX_BATCH_PER_CALL inputs.
      // Result vectors concatenated in input-array order.
      const allVectors: number[][] = [];
      let totalPromptTokens = 0;
      let dimensions = 0;
      for (let i = 0; i < inputs.length; i += MAX_BATCH_PER_CALL) {
        const chunk = inputs.slice(i, i + MAX_BATCH_PER_CALL);
        const r: EmbedResult = await route.provider.embed(route.apiKey, route.modelId, chunk, {
          dimensions: parsed.dimensions,
          inputType: parsed.input_type,
        });
        if (!dimensions) dimensions = r.dimensions;
        if (dimensions && r.dimensions && r.dimensions !== dimensions) {
          throw new Error(`Embed dimension mismatch across chunks: got ${r.dimensions} vs ${dimensions}`);
        }
        if (targetDim !== undefined && r.dimensions && r.dimensions !== targetDim) {
          throw new Error(`Embed dimension mismatch: ${route.modelId} returned ${r.dimensions}-dim, pinned needs ${targetDim}-dim`);
        }
        totalPromptTokens += r.promptTokens;
        for (const v of r.vectors) allVectors.push(v);
      }
      if (allVectors.length !== inputs.length) {
        throw new Error(`Embed result count mismatch: got ${allVectors.length}, expected ${inputs.length}`);
      }

      recordTokens(route.platform, route.modelId, route.keyId, totalPromptTokens);
      recordSuccess(route.modelDbId);

      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: totalPromptTokens,
        outputTokens: 0,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        responseFormat: parsed.encoding_format ?? 'float',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'embedding',
      });

      const result: EmbeddingRunResult = {
        vectors: allVectors,
        routedPlatform: route.platform,
        routedModel: route.modelId,
        routedDisplayName: route.displayName,
        promptTokens: totalPromptTokens,
        dimensions,
        attempts: attempt,
        latencyMs: Date.now() - start,
      };
      if (cacheable) embedCache.set(cacheKey, result);
      return result;
    } catch (err: any) {
      const latency = Date.now() - start;
      const errClass = classifyError(err?.message ?? '');
      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: errClass,
        attempts: attempt,
        responseFormat: parsed.encoding_format ?? 'float',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'embedding',
      });

      // Dimension mismatch: the routed model works, it just produces a
      // different vector size than the pinned model. Skip for this request
      // and cascade — no cooldown (the model is not unhealthy).
      if (/dimension mismatch/i.test(err?.message ?? '')) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        lastError = err;
        console.log(`[Embed] ${(err?.message ?? '').slice(0, 90)}, skipping model (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        if (errClass === 'invalid_key' || errClass === 'rate_limit_day') {
          setKeyCooldown(route.platform, route.keyId, errClass);
        } else {
          setCooldown(route.platform, route.modelId, route.keyId, errClass);
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Embed] ${err.message.slice(0, 60)} from ${route.displayName} (${errClass}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
