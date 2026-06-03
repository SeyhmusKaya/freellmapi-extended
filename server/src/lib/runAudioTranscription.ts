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

const MAX_RETRIES = 6;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_MIME = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/webm', 'audio/m4a', 'audio/mp4', 'audio/x-m4a'];
const AUDIO_FETCH_TIMEOUT_MS = 30_000;

const audioRefSchema = z.string().refine(
  (u) => u.startsWith('data:audio/') || u.startsWith('https://') || u.startsWith('http://'),
  { message: 'audio must be data:audio/* or http(s)://' },
);

export const audioTranscriptionSchema = z.object({
  audio: audioRefSchema,
  model: z.string().optional(),
  language: z.string().min(2).max(8).optional(),
  response_format: z.enum(['json', 'text', 'verbose_json']).optional(),
  temperature: z.number().min(0).max(1).optional(),
  prompt: z.string().max(2000).optional(),
});

export type AudioTranscriptionRequest = z.infer<typeof audioTranscriptionSchema>;

export interface AudioTranscriptionRunResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
  routedPlatform: string;
  routedModel: string;
  routedDisplayName: string;
  attempts: number;
  latencyMs: number;
}

function isPrivateHost(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fe80:')) return true;
  return false;
}

async function loadAudioBytes(ref: string): Promise<{ buf: Buffer; mime: string }> {
  if (ref.startsWith('data:')) {
    const m = ref.match(/^data:(audio\/[\w+.-]+);base64,(.+)$/i);
    if (!m) throw new Error('invalid data URL (expected data:audio/<type>;base64,...)');
    const mime = m[1].toLowerCase();
    if (!ALLOWED_AUDIO_MIME.includes(mime)) throw new Error(`audio MIME not allowed: ${mime}`);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_AUDIO_BYTES) throw new Error(`audio too large: ${buf.length} > ${MAX_AUDIO_BYTES}`);
    return { buf, mime };
  }
  if (!(ref.startsWith('http://') || ref.startsWith('https://'))) {
    throw new Error('audio must be data:audio/* or http(s)://');
  }
  let parsed: URL;
  try { parsed = new URL(ref); } catch { throw new Error('audio url invalid'); }
  if (isPrivateHost(parsed.hostname)) throw new Error('audio url host blocked (private/loopback)');
  const res = await fetch(ref, { signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`audio fetch failed: HTTP ${res.status}`);
  const mime = (res.headers.get('content-type') ?? 'audio/wav').split(';')[0].trim().toLowerCase();
  // Allow content-type that starts with 'audio/' even if not in whitelist —
  // CF Whisper is permissive on container formats.
  if (!mime.startsWith('audio/')) throw new Error(`audio MIME not allowed: ${mime}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_AUDIO_BYTES) throw new Error(`audio too large: ${buf.length} > ${MAX_AUDIO_BYTES}`);
  return { buf, mime };
}

function resolveAudioModel(requestedModel: string | undefined): number | undefined {
  if (!requestedModel) return undefined;
  const db = getDb();
  const row = (db.prepare('SELECT id, enabled, modality FROM models WHERE model_id = ?').get(requestedModel)
    ?? db.prepare("SELECT id, enabled, modality FROM models WHERE model_id LIKE ?").get(`%/${requestedModel}`)) as
      { id: number; enabled: number; modality: string | null } | undefined;
  if (!row) throw new ModelNotFoundError(requestedModel, false);
  if (!row.enabled) throw new ModelNotFoundError(requestedModel, true);
  if (row.modality !== 'audio_stt') return undefined;
  return row.id;
}

export async function runAudioTranscription(parsed: AudioTranscriptionRequest): Promise<AudioTranscriptionRunResult> {
  const start = Date.now();
  const reqId = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const audioData = await loadAudioBytes(parsed.audio);
  const preferredModel = resolveAudioModel(parsed.model);
  // Estimated neurons: ~150 per minute. We don't know duration upfront; use a
  // conservative flat 200.
  const estimatedNeurons = 200;

  const skipKeys = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedNeurons, skipKeys.size > 0 ? skipKeys : undefined, preferredModel,
        false, false, false, 'audio_stt');
    } catch (err: any) {
      if (lastError) throw new AllProvidersFailedError(lastError.message);
      throw new RoutingError(err.message, err.status ?? 503);
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.transcribeAudio(route.apiKey, route.modelId, audioData.buf, {
        language: parsed.language,
        prompt: parsed.prompt,
        temperature: parsed.temperature,
        responseFormat: parsed.response_format,
      });

      const neuronsRow = getDb().prepare('SELECT neurons_per_call FROM models WHERE platform = ? AND model_id = ?')
        .get(route.platform, route.modelId) as { neurons_per_call: number | null } | undefined;
      const neuronsUsed = neuronsRow?.neurons_per_call ?? 200;
      recordTokens(route.platform, route.modelId, route.keyId, neuronsUsed);
      recordSuccess(route.modelDbId);

      logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: audioData.buf.length,   // raw audio byte count (approx)
        outputTokens: result.text.length,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        responseFormat: 'audio_stt',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'audio_stt',
      });

      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        segments: result.segments,
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
        inputTokens: audioData.buf.length,
        outputTokens: 0,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: errClass,
        attempts: attempt,
        responseFormat: 'audio_stt',
        keyId: route.keyId,
        requestId: reqId,
        modality: 'audio_stt',
      });

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        const reason = classifyError(err.message);
        if (reason === 'invalid_key' || reason === 'rate_limit_day') {
          setKeyCooldown(route.platform, route.keyId, reason);
        } else {
          setCooldown(route.platform, route.modelId, route.keyId, reason);
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Audio] ${err.message.slice(0, 60)} from ${route.displayName} (${reason}), falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      throw new ProviderFatalError(route.displayName, err);
    }
  }

  throw new AllProvidersFailedError(lastError?.message ?? 'unknown');
}
