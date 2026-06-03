import { z } from 'zod';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, setKeyCooldown, classifyError } from '../services/ratelimit.js';
import { getDb } from '../db/index.js';
import {
  isRetryableError,
  ModelNotFoundError,
  AllProvidersFailedError,
  ProviderFatalError,
  RoutingError,
  logRequest,
} from './runChatCompletion.js';

const MAX_RETRIES = 8;

// ---- Schema ----

export const imageGenerationSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.enum(['512x512', '1024x1024', '1024x768', '768x1024']).optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
  negative_prompt: z.string().max(1000).optional(),
  seed: z.number().int().optional(),
  quality: z.enum(['standard', 'hd']).optional(),
});

export type ImageGenerationRequest = z.infer<typeof imageGenerationSchema>;

// ---- Result ----

export interface ImageGenerationRunResult {
  images: string[];         // base64 PNG bytes
  mimeType: string;
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  attempts: number;
  latencyMs: number;
}

// ---- Helpers ----

/**
 * Pinned model resolver for image generation. Drops the pin when the pinned
 * model isn't image-gen (modality != 'image_gen') so we don't error out on
 * a chat-completion model id appearing on an /images request.
 */
export function resolveImageGenModel(requestedModel: string | undefined): number | undefined {
  if (!requestedModel) return undefined;
  const db = getDb();
  // Caller may give the bare model id ("flux-1-schnell") or the full CF id
  // ("@cf/black-forest-labs/flux-1-schnell"). Match on full id first, then
  // suffix match for convenience.
  const row = (db.prepare('SELECT id, enabled, modality FROM models WHERE model_id = ?').get(requestedModel)
            ?? db.prepare("SELECT id, enabled, modality FROM models WHERE model_id LIKE ?").get(`%/${requestedModel}`)) as
              { id: number; enabled: number; modality: string | null } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (row.modality !== 'image_gen') {
    // Pin was a text model — drop and auto-route to image-gen.
    return undefined;
  }
  return row.id;
}

// ---- Core ----

export async function runImageGeneration(parsed: ImageGenerationRequest): Promise<ImageGenerationRunResult> {
  const start = Date.now();
  const { prompt, model: requestedModel, n, size, negative_prompt, seed, quality } = parsed;

  const preferredModel = resolveImageGenModel(requestedModel);
  const reqId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Token estimate for usage_counters bookkeeping. CF is neuron-based; we
  // approximate one image = neurons_per_call (from models row) but at routing
  // time we only have an estimate. Use a conservative 100 neurons unless the
  // model row tells us otherwise.
  const estimatedNeurons = (n ?? 1) * 100;

  const skipKeys = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedNeurons, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, false, false, false, 'image_gen');
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.generateImage(
        route.apiKey,
        route.modelId,
        prompt,
        { n, size, negative_prompt, seed, quality },
      );

      // Approximate neuron usage by row's neurons_per_call when present.
      const neuronsRow = getDb().prepare("SELECT neurons_per_call FROM models WHERE platform = ? AND model_id = ?")
        .get(route.platform, route.modelId) as { neurons_per_call: number | null } | undefined;
      const neuronsUsed = (neuronsRow?.neurons_per_call ?? 100) * (n ?? 1);
      recordTokens(route.platform, route.modelId, route.keyId, neuronsUsed);
      recordSuccess(route.modelDbId);

      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: prompt.length,
        outputTokens: neuronsUsed,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        hasImage: false,
        responseFormat: 'image',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'image_gen',
      });

      return {
        images: result.b64Images,
        mimeType: result.mimeType,
        routedPlatform: route.platform,
        routedModel: route.modelId,
        routedDisplayName: route.displayName,
        attempts: attempt,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      const latency = Date.now() - start;
      const errClass = classifyError(err?.message ?? '');
      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'error',
        inputTokens: prompt.length,
        outputTokens: 0,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: errClass,
        attempts: attempt,
        hasImage: false,
        responseFormat: 'image',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'image_gen',
      });

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        const reason = classifyError(err.message);
        // Image-gen: only day-bucket exhaustion (shared CF neuron pool) is
        // truly key-wide. An `invalid_key`-classified error here is almost
        // always a single deprecated model returning 401/403 — NOT a dead
        // key — so it must NOT lock the whole provider (that would take
        // working models like FLUX.2 down with it). Genuine key death is
        // still caught key-wide by the chat/embedding dispatchers.
        if (reason === 'rate_limit_day') {
          setKeyCooldown(route.platform, route.keyId, reason);
        } else {
          setCooldown(route.platform, route.modelId, route.keyId, reason);
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[ImageGen] ${err.message.slice(0, 60)} from ${route.displayName} (${reason}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
