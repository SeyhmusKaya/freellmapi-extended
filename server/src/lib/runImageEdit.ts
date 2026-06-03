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

const imageRefSchema = z.string().refine(
  (u) => u.startsWith('data:image/') || u.startsWith('https://') || u.startsWith('http://'),
  { message: 'image must be data:image/* or http(s)://' },
);

export const imageEditSchema = z.object({
  prompt: z.string().min(1).max(4000),
  image: imageRefSchema,
  mask: imageRefSchema.optional(),
  model: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.enum(['512x512', '1024x1024', '1024x768', '768x1024']).optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
  strength: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
});

export const imageVariationSchema = z.object({
  image: imageRefSchema,
  prompt: z.string().max(4000).optional(),
  model: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.enum(['512x512', '1024x1024', '1024x768', '768x1024']).optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
  strength: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
});

export type ImageEditRequest = z.infer<typeof imageEditSchema>;
export type ImageVariationRequest = z.infer<typeof imageVariationSchema>;

// ---- Result ----

export interface ImageEditRunResult {
  images: string[];         // base64 PNG bytes
  mimeType: string;
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  attempts: number;
  latencyMs: number;
}

// ---- Pin resolver ----

function resolveImageEditModel(requestedModel: string | undefined, requireInpainting: boolean): number | undefined {
  if (!requestedModel) return undefined;
  const db = getDb();
  const row = (db.prepare(
    'SELECT id, enabled, modality, supports_img2img, supports_inpainting FROM models WHERE model_id = ?'
  ).get(requestedModel)
    ?? db.prepare(
      'SELECT id, enabled, modality, supports_img2img, supports_inpainting FROM models WHERE model_id LIKE ?'
    ).get(`%/${requestedModel}`)) as
      { id: number; enabled: number; modality: string | null; supports_img2img: number; supports_inpainting: number } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (row.modality !== 'image_gen') return undefined;
  if (requireInpainting && row.supports_inpainting !== 1) return undefined;
  if (!requireInpainting && row.supports_img2img !== 1) return undefined;
  return row.id;
}

// ---- Core ----

export async function runImageEdit(parsed: ImageEditRequest | ImageVariationRequest): Promise<ImageEditRunResult> {
  const start = Date.now();
  const editLike = parsed as ImageEditRequest;        // narrow when present
  const variationLike = parsed as ImageVariationRequest;
  const hasMask = !!(editLike as any).mask;
  const requireInpainting = hasMask;

  // V27 (May 2026): img2img / variations route to Pollinations.ai flux
  // (`?image=URL`). CF dropped img2img across all SD models in V25.
  // Inpainting (with mask) still routes to CF SD-1.5-inpainting.
  // If catalog has no img2img-capable row enabled (e.g. Pollinations row
  // disabled), fail-fast with 501 instead of cycling MAX_RETRIES.
  if (!requireInpainting) {
    const db = getDb();
    const liveImg2Img = (db.prepare(
      "SELECT 1 AS ok FROM models WHERE modality='image_gen' AND supports_img2img=1 AND enabled=1 LIMIT 1"
    ).get()) as { ok: number } | undefined;
    if (!liveImg2Img) {
      throw new RoutingError(
        'No provider supports plain img2img/variations. Enable the Pollinations flux row in models (supports_img2img=1) or supply a mask for inpainting.',
        501,
      );
    }
  }

  const reqId = `imgedit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const preferredModel = resolveImageEditModel(parsed.model, requireInpainting);
  const estimatedNeurons = (parsed.n ?? 1) * 100;

  // For variations: synthesize a generic prompt if caller omitted one,
  // so the upstream model has something to condition on.
  const promptForCall =
    (editLike as any).prompt ?? variationLike.prompt ?? 'high quality image, faithful variation of input';

  const skipKeys = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedNeurons,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        false,        // requireVision
        false,        // requireJsonMode
        false,        // excludeReasoning
        'image_gen',
        { requireInpainting, requireImg2Img: !requireInpainting },
      );
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.editImage(route.apiKey, route.modelId, {
        prompt: promptForCall,
        image: (parsed as any).image,
        mask: (editLike as any).mask,
        n: parsed.n,
        size: parsed.size,
        strength: parsed.strength,
        seed: parsed.seed,
      });

      const neuronsRow = getDb().prepare('SELECT neurons_per_call FROM models WHERE platform = ? AND model_id = ?')
        .get(route.platform, route.modelId) as { neurons_per_call: number | null } | undefined;
      const neuronsUsed = (neuronsRow?.neurons_per_call ?? 100) * (parsed.n ?? 1);
      recordTokens(route.platform, route.modelId, route.keyId, neuronsUsed);
      recordSuccess(route.modelDbId);

      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: promptForCall.length,
        outputTokens: neuronsUsed,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        hasImage: true,
        responseFormat: requireInpainting ? 'image_inpaint' : 'image_edit',
        keyId: route.keyId,
        requestId: reqId,
        modality: requireInpainting ? 'image_inpaint' : 'image_edit',
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
        inputTokens: promptForCall.length,
        outputTokens: 0,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: errClass,
        attempts: attempt,
        hasImage: true,
        responseFormat: requireInpainting ? 'image_inpaint' : 'image_edit',
        keyId: route.keyId,
        requestId: reqId,
        modality: requireInpainting ? 'image_inpaint' : 'image_edit',
      });

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        const reason = classifyError(err.message);
        // See runImageGeneration: image-gen `invalid_key` is a per-model
        // deprecation signal, not a dead key — keep it model-specific so it
        // can't lock working models on the same provider key.
        if (reason === 'rate_limit_day') {
          setKeyCooldown(route.platform, route.keyId, reason);
        } else {
          setCooldown(route.platform, route.modelId, route.keyId, reason);
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[ImageEdit] ${err.message.slice(0, 60)} from ${route.displayName} (${reason}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
