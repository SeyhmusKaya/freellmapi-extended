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
import type { RerankResult } from '../providers/base.js';
import { ResultCache, hashKey } from './resultCache.js';

// Rerank is deterministic for a given (model, query, documents) — cache it.
// Cohere's free trial is only 1000 calls/MONTH/key, so repeated reranks of the
// same candidate set (common when a UI re-queries) are worth memoising.
// Only modest document sets are cached to bound memory.
const RERANK_CACHE_MAX_DOCS = 200;
const rerankCache = new ResultCache<RerankRunResult>(300, 60 * 60 * 1000);

/**
 * /v1/rerank core. Cohere-shape body. Cascade router across the 'rerank'
 * modality catalog (currently 3 Cohere rerank rows).
 */

const MAX_RETRIES = 4;
const MAX_DOCS = 1000;          // Cohere hard limit; we just pass through
const MAX_DOC_LEN = 16384;      // 16K chars per doc

export const rerankSchema = z.object({
  model: z.string().optional(),
  query: z.string().min(1).max(4096),
  documents: z.array(z.string().min(1).max(MAX_DOC_LEN)).min(1).max(MAX_DOCS),
  top_n: z.number().int().min(1).max(MAX_DOCS).optional(),
  max_chunks_per_doc: z.number().int().min(1).max(50).optional(),
  // OpenAI-like passthrough for analytics tagging
  user: z.string().optional(),
  // Some clients want the document echoed in the response for convenience.
  return_documents: z.boolean().optional(),
});

export type RerankRequest = z.infer<typeof rerankSchema>;

export interface RerankRunResult {
  results: Array<{ index: number; relevance_score: number; document?: string }>;
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  searchUnits: number;
  attempts: number;
  latencyMs: number;
}

function resolveRerankModel(requestedModel: string | undefined): number | undefined {
  if (!requestedModel) return undefined;
  const db = getDb();
  const row = (db.prepare('SELECT id, enabled, modality FROM models WHERE model_id = ?').get(requestedModel)
    ?? db.prepare("SELECT id, enabled, modality FROM models WHERE model_id LIKE ?").get(`%/${requestedModel}`)) as
      { id: number; enabled: number; modality: string | null } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (row.modality !== 'rerank') return undefined;
  return row.id;
}

export async function runRerank(parsed: RerankRequest): Promise<RerankRunResult> {
  const start = Date.now();
  const preferredModel = resolveRerankModel(parsed.model);
  const reqId = `rerank_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  // ~1 search unit/request on Cohere; passthrough cost ~5 tokens estimate
  const estimatedNeurons = 5;

  // Cache lookup — key covers everything that changes the ranking.
  const cacheable = parsed.documents.length <= RERANK_CACHE_MAX_DOCS;
  const cacheKey = cacheable
    ? hashKey('rerank', parsed.model ?? 'auto', parsed.top_n ?? 0,
        parsed.max_chunks_per_doc ?? 0, parsed.return_documents === true,
        parsed.query, parsed.documents)
    : '';
  if (cacheable) {
    const hit = rerankCache.get(cacheKey);
    if (hit) return { ...hit, attempts: 0, latencyMs: Date.now() - start };
  }

  const skipKeys = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedNeurons, skipKeys.size > 0 ? skipKeys : undefined, preferredModel,
        false, false, false, 'rerank');
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const r: RerankResult = await route.provider.rerank(route.apiKey, route.modelId, parsed.query, parsed.documents, {
        topN: parsed.top_n,
        maxChunksPerDoc: parsed.max_chunks_per_doc,
      });

      // Estimate prompt tokens (~4 char/token over query + all docs)
      const totalChars = parsed.query.length + parsed.documents.reduce((s, d) => s + d.length, 0);
      const promptTokens = Math.ceil(totalChars / 4);
      recordTokens(route.platform, route.modelId, route.keyId, promptTokens);
      recordSuccess(route.modelDbId);

      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: promptTokens,
        outputTokens: 0,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        responseFormat: 'rerank',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'rerank',
      });

      const echoDocs = parsed.return_documents === true;
      const result: RerankRunResult = {
        results: r.results.map(x => ({
          index: x.index,
          relevance_score: x.relevanceScore,
          ...(echoDocs ? { document: parsed.documents[x.index] } : {}),
        })),
        routedPlatform: route.platform,
        routedModel: route.modelId,
        routedDisplayName: route.displayName,
        searchUnits: r.searchUnits,
        attempts: attempt,
        latencyMs: Date.now() - start,
      };
      if (cacheable) rerankCache.set(cacheKey, result);
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
        responseFormat: 'rerank',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'rerank',
      });

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
        console.log(`[Rerank] ${err.message.slice(0, 60)} from ${route.displayName} (${errClass}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
