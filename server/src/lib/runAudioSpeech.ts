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
import type { TtsResult } from '../providers/base.js';

/**
 * /v1/audio/speech core. OpenAI-compatible text-to-speech with multi-provider
 * cascade. Today only Cloudflare MeloTTS is wired (V32). Voice param maps to
 * MeloTTS language code (en/es/fr/zh/ja/ko); other OpenAI voice names default
 * to English.
 */

const MAX_RETRIES = 4;
const MAX_INPUT_CHARS = 5000;

export const audioSpeechSchema = z.object({
  model: z.string().optional(),
  // OpenAI uses `input` for the text to synthesize.
  input: z.string().min(1).max(MAX_INPUT_CHARS),
  voice: z.string().optional(),
  // OpenAI supports mp3 (default) | opus | aac | flac | wav | pcm. We accept
  // the same enum but provider may reject — handled per-provider.
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav']).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
});

export type AudioSpeechRequest = z.infer<typeof audioSpeechSchema>;

export interface AudioSpeechRunResult {
  audio: Buffer;
  mimeType: string;
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  attempts: number;
  latencyMs: number;
}

function resolveTtsModel(requestedModel: string | undefined): number | undefined {
  if (!requestedModel) return undefined;
  const db = getDb();
  const row = (db.prepare('SELECT id, enabled, modality FROM models WHERE model_id = ?').get(requestedModel)
    ?? db.prepare("SELECT id, enabled, modality FROM models WHERE model_id LIKE ?").get(`%/${requestedModel}`)) as
      { id: number; enabled: number; modality: string | null } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (row.modality !== 'audio_tts') return undefined;
  return row.id;
}

export async function runAudioSpeech(parsed: AudioSpeechRequest): Promise<AudioSpeechRunResult> {
  const start = Date.now();
  const preferredModel = resolveTtsModel(parsed.model);
  const reqId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  // ~30 neurons/call on CF MeloTTS, low cost vs image-gen.
  const estimatedNeurons = 30;

  const skipKeys = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedNeurons, skipKeys.size > 0 ? skipKeys : undefined, preferredModel,
        false, false, false, 'audio_tts');
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result: TtsResult = await route.provider.synthesizeSpeech(route.apiKey, route.modelId, parsed.input, {
        voice: parsed.voice,
        responseFormat: parsed.response_format,
        speed: parsed.speed,
      });

      // input token estimate for usage tracking (~4 char/token)
      const promptTokens = Math.ceil(parsed.input.length / 4);
      recordTokens(route.platform, route.modelId, route.keyId, promptTokens);
      recordSuccess(route.modelDbId);

      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: promptTokens,
        outputTokens: result.audio.length,   // audio byte count (proxy for "size delivered")
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        responseFormat: parsed.response_format ?? 'mp3',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'audio_tts',
      });

      return {
        audio: result.audio,
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
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: errClass,
        attempts: attempt,
        responseFormat: parsed.response_format ?? 'mp3',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'audio_tts',
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
        console.log(`[TTS] ${err.message.slice(0, 60)} from ${route.displayName} (${errClass}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
