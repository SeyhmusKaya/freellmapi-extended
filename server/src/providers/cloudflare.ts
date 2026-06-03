import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatContentPart,
} from '@myllm/shared/types.js';
import { BaseProvider, type CompletionOptions, type ImageGenerationOptions, type ImageGenerationResult, type ImageEditOptions, type AudioTranscribeOptions, type AudioTranscribeResult, type EmbedOptions, type EmbedResult, type TtsOptions, type TtsResult } from './base.js';

const AUDIO_TIMEOUT_MS = Number(process.env.MYLLM_AUDIO_TIMEOUT_MS ?? 120_000);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — OpenAI Whisper limit shape

// CF image-gen step counts vary by model. Bigger step count = better quality
// but more neurons spent. These match the model card defaults.
const STEP_COUNT_BY_MODEL: Record<string, number> = {
  '@cf/black-forest-labs/flux-1-schnell': 4,
  '@cf/bytedance/stable-diffusion-xl-lightning': 8,
  '@cf/lykon/dreamshaper-8-lcm': 4,
  '@cf/stabilityai/stable-diffusion-xl-base-1.0': 30,
  '@cf/runwayml/stable-diffusion-v1-5-inpainting': 20,
  // FLUX.2 klein/dev — CF docs: optimized 4-step inference, no need to bump
  '@cf/black-forest-labs/flux-2-klein-9b': 4,
  '@cf/black-forest-labs/flux-2-klein-4b': 4,
  '@cf/black-forest-labs/flux-2-dev': 28,
};
const IMAGE_GEN_TIMEOUT_MS = Number(process.env.MYLLM_IMAGE_TIMEOUT_MS ?? 60_000);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

// CF image-gen endpoints return EITHER raw binary (octet-stream — older SD
// models) OR a JSON envelope {"result":{"image":"<base64>"}} (newer models).
// An OpenAI-compatible caller base64-decodes b64_json directly, so a JSON
// envelope passed through verbatim produces a corrupt image. Detect by
// Content-Type and always yield plain base64 of the actual image bytes.
async function readCfImageB64(res: Response, modelId: string): Promise<string> {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    const data = await res.json() as { result?: { image?: string }; image?: string };
    const b64 = data.result?.image ?? data.image;
    if (!b64) throw new Error(`Cloudflare image API: empty JSON response from ${modelId}`);
    return b64;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`Cloudflare image API: empty response from ${modelId}`);
  return buf.toString('base64');
}

// SSRF guard. Cloudflare's OpenAI-compat layer only accepts base64 data URLs
// for image_url, so we have to fetch http(s) URLs ourselves and inline them.
// Refuse private / link-local hosts to prevent using MyLLM as an internal
// scanner via image URLs.
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
  if (h === '::1' || h.startsWith('[::1]')) return true;
  if (h.startsWith('fe80:') || h.startsWith('[fe80:')) return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('[fc') || h.startsWith('[fd')) return true;
  return false;
}

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const { buf, mime } = await loadImageBytes(url);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Load image bytes from data: URL or http(s) URL with SSRF guard + size +
// MIME whitelist. Returns raw Buffer so callers that need byte arrays
// (CF img2img) don't double-decode.
async function loadImageBytes(url: string): Promise<{ buf: Buffer; mime: string }> {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:(image\/[\w+.-]+);base64,(.+)$/i);
    if (!m) throw new Error('invalid data URL (expected data:image/<type>;base64,...)');
    const mime = m[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.includes(mime)) throw new Error(`image MIME not allowed: ${mime}`);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${buf.length} > ${MAX_IMAGE_BYTES}`);
    return { buf, mime };
  }
  if (!(url.startsWith('http://') || url.startsWith('https://'))) {
    throw new Error('image url must be data:image/* or http(s)://');
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('image url is not a valid URL'); }
  if (isPrivateHost(parsed.hostname)) throw new Error('image url host blocked (private/loopback)');
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime)) throw new Error(`image MIME not allowed: ${mime}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${buf.length} > ${MAX_IMAGE_BYTES}`);
  return { buf, mime };
}

// Walk message content. For any image_url part with http(s) URL, fetch the
// bytes and replace with a data URL so Cloudflare accepts it.
async function inlineRemoteImages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) { out.push(m); continue; }
    const parts: ChatContentPart[] = [];
    for (const p of m.content) {
      if (p.type === 'image_url') {
        const url = p.image_url.url;
        if (url.startsWith('data:')) {
          parts.push(p);
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
          const dataUrl = await fetchImageAsDataUrl(url);
          parts.push({ type: 'image_url', image_url: { ...p.image_url, url: dataUrl } });
        } else {
          throw new Error('image_url.url must be data:image/* or http(s)://');
        }
      } else {
        parts.push(p);
      }
    }
    out.push({ ...m, content: parts });
  }
  return out;
}

/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be in format "account_id:api_token"');
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  // Cloudflare's OpenAI-compat endpoint rejects `content: null` on assistant
  // messages that carry tool_calls, even though the OpenAI spec allows it.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m =>
      m.content === null ? { ...m, content: '' } : m,
    );
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(await inlineRemoteImages(messages)),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        response_format: options?.response_format,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(await inlineRemoteImages(messages)),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        response_format: options?.response_format,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    const { token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
    const data = await res.json() as any;
    return data.success === true && data.result?.status === 'active';
  }

  /**
   * Cloudflare Workers AI image generation.
   *
   * Endpoint: POST /client/v4/accounts/<account_id>/ai/run/<model>
   * Body: { prompt, negative_prompt?, num_steps, seed?, width, height }
   * Response: binary PNG bytes (octet-stream) — wrap in base64.
   *
   * `n` > 1: CF returns one image per call. We serialize N calls; cooldown
   * + neurons accounted per-call by the caller (router records once per
   * route hit; for n>1 we eat from the same 10K Neurons/day pool).
   */
  async generateImage(
    apiKey: string,
    modelId: string,
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
    const [w, h] = (options?.size ?? '1024x1024').split('x').map(Number);
    const numSteps = STEP_COUNT_BY_MODEL[modelId] ?? 8;
    const n = Math.max(1, Math.min(options?.n ?? 1, 4));

    // FLUX.2 (klein-9b / dev) uses multipart/form-data + JSON response with
    // `result.image` base64. Separate path so the old SD-family JSON code
    // stays untouched.
    if (modelId.includes('flux-2')) {
      const callOnceFlux2 = async (): Promise<string> => {
        const fd = new FormData();
        fd.append('prompt', prompt);
        fd.append('steps',  String(numSteps));
        fd.append('width',  String(Number.isFinite(w) ? Math.min(w, 1024) : 1024));
        fd.append('height', String(Number.isFinite(h) ? Math.min(h, 1024) : 1024));
        if (options?.seed != null) fd.append('seed', String(options.seed));
        const res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd as any,
        }, IMAGE_GEN_TIMEOUT_MS);
        if (!res.ok) {
          let msg = res.statusText;
          try { const e = await res.json() as any; msg = e.errors?.[0]?.message ?? msg; } catch {}
          throw new Error(`Cloudflare image API error ${res.status}: ${msg}`);
        }
        const data = await res.json() as { result?: { image?: string } };
        const b64 = data.result?.image;
        if (!b64) throw new Error(`Cloudflare image API: empty response from ${modelId}`);
        return b64;
      };
      const flux2Out: string[] = [];
      for (let i = 0; i < n; i++) flux2Out.push(await callOnceFlux2());
      return { b64Images: flux2Out, mimeType: 'image/jpeg' };
    }

    const callOnce = async (): Promise<string> => {
      const body: Record<string, unknown> = {
        prompt,
        num_steps: numSteps,
        width: Number.isFinite(w) ? w : 1024,
        height: Number.isFinite(h) ? h : 1024,
      };
      if (options?.negative_prompt) body.negative_prompt = options.negative_prompt;
      if (options?.seed != null) body.seed = options.seed;

      const res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, IMAGE_GEN_TIMEOUT_MS);

      if (!res.ok) {
        let msg = res.statusText;
        try {
          const err = await res.json() as any;
          msg = err.errors?.[0]?.message ?? err.error?.message ?? msg;
        } catch { /* binary or non-json error */ }
        throw new Error(`Cloudflare image API error ${res.status}: ${msg}`);
      }
      return readCfImageB64(res, modelId);
    };

    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await callOnce());
    }
    return { b64Images: out, mimeType: 'image/png' };
  }

  /**
   * Image-to-image (img2img) and inpainting via Cloudflare Workers AI.
   *
   * CF accepts the source image as a byte array in the JSON body (not multipart).
   * If `mask` is set the model treats it as inpainting (mask white areas are
   * the regions to repaint); without mask it's img2img with `strength`
   * controlling deviation from the source.
   *
   * The same endpoint as generateImage. Step counts come from the per-model
   * map; img2img/inpainting typically uses 20 steps for SD-1.5.
   */
  async editImage(
    apiKey: string,
    modelId: string,
    opts: ImageEditOptions,
  ): Promise<ImageGenerationResult> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
    const [w, h] = (opts.size ?? '1024x1024').split('x').map(Number);
    const numSteps = STEP_COUNT_BY_MODEL[modelId] ?? 20;
    const n = Math.max(1, Math.min(opts.n ?? 1, 4));

    // FLUX.2 klein/dev (Nov 2025 / Jan 2026) uses multipart/form-data with
    // input_image_0..3 binary fields, not the JSON byte-array shape SD-1.5
    // expects. No mask support - reference-image guided generation only.
    if (modelId.includes('flux-2')) {
      const imgBuf = (await loadImageBytes(opts.image)).buf;
      const callOnceMp = async (idx: number): Promise<string> => {
        const fd = new FormData();
        fd.append('prompt', opts.prompt);
        fd.append('steps', String(numSteps));
        fd.append('width',  String(Number.isFinite(w) ? Math.min(w, 1024) : 1024));
        fd.append('height', String(Number.isFinite(h) ? Math.min(h, 1024) : 1024));
        // Source <512x512 cap per CF docs; resize if needed before this call.
        fd.append('input_image_0', new Blob([imgBuf], { type: 'image/png' }), 'src.png');
        if (opts.seed != null) fd.append('seed', String(opts.seed + idx));
        const res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd as any,
        }, IMAGE_GEN_TIMEOUT_MS);
        if (!res.ok) {
          let msg = res.statusText;
          try { const e = await res.json() as any; msg = e.errors?.[0]?.message ?? msg; } catch {}
          throw new Error(`Cloudflare image API error ${res.status}: ${msg}`);
        }
        const data = await res.json() as { result?: { image?: string } };
        const b64 = data.result?.image;
        if (!b64) throw new Error(`Cloudflare image API: empty response from ${modelId}`);
        return b64;
      };
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push(await callOnceMp(i));
      return { b64Images: out, mimeType: 'image/jpeg' };
    }

    const imageData = await loadImageBytes(opts.image);
    const maskData  = opts.mask ? await loadImageBytes(opts.mask) : null;

    const callOnce = async (idx: number): Promise<string> => {
      const body: Record<string, unknown> = {
        prompt: opts.prompt,
        image: Array.from(imageData.buf),
        num_steps: numSteps,
        strength: opts.strength ?? 0.7,
        width: Number.isFinite(w) ? w : 1024,
        height: Number.isFinite(h) ? h : 1024,
      };
      if (maskData) body.mask = Array.from(maskData.buf);
      if (opts.seed != null) body.seed = opts.seed + idx;

      const res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, IMAGE_GEN_TIMEOUT_MS);

      if (!res.ok) {
        let msg = res.statusText;
        try {
          const err = await res.json() as any;
          msg = err.errors?.[0]?.message ?? err.error?.message ?? msg;
        } catch { /* binary or non-json */ }
        throw new Error(`Cloudflare image API error ${res.status}: ${msg}`);
      }
      return readCfImageB64(res, modelId);
    };

    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await callOnce(i));
    return { b64Images: out, mimeType: 'image/png' };
  }

  /**
   * Audio transcription via Cloudflare Workers AI (Whisper-large-v3-turbo).
   *
   * CF accepts audio as a byte array in JSON body (same shape as image-gen).
   * Returns { text, vtt?, word_count?, words? }. We coerce to the OpenAI
   * Whisper response shape: { text, language?, duration?, segments? }.
   */
  async transcribeAudio(
    apiKey: string,
    modelId: string,
    audio: Buffer,
    options?: AudioTranscribeOptions,
  ): Promise<AudioTranscribeResult> {
    if (audio.length > MAX_AUDIO_BYTES) {
      throw new Error(`audio too large: ${audio.length} > ${MAX_AUDIO_BYTES}`);
    }
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

    // CF Whisper API (2026): audio MUST be base64-encoded string. Array form
    // (older API) rejected as "Type mismatch of '/audio', 'string' not in
    // 'array','binary'". Probed against @cf/openai/whisper-large-v3-turbo.
    const body: Record<string, unknown> = { audio: audio.toString('base64') };
    if (options?.language) body.language = options.language;
    if (options?.prompt) body.initial_prompt = options.prompt;
    if (options?.temperature != null) body.temperature = options.temperature;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, AUDIO_TIMEOUT_MS);

    if (!res.ok) {
      let msg = res.statusText;
      try {
        const err = await res.json() as any;
        msg = err.errors?.[0]?.message ?? err.error?.message ?? msg;
      } catch { /* non-json */ }
      throw new Error(`Cloudflare audio API error ${res.status}: ${msg}`);
    }

    const data = await res.json() as { result?: any; success?: boolean };
    // CF returns either top-level fields or nested under `result`. Normalize.
    const r = data.result ?? data;
    const text: string = r.text ?? r.transcription ?? '';
    const segments = Array.isArray(r.words)
      ? r.words.map((w: any) => ({ start: w.start ?? 0, end: w.end ?? 0, text: w.word ?? w.text ?? '' }))
      : undefined;

    return {
      text,
      language: r.language,
      duration: r.duration,
      segments,
    };
  }

  /**
   * Text embeddings via Cloudflare Workers AI BGE models.
   *
   * Endpoint: POST .../ai/run/<modelId>
   *   body  : {"text": ["str1","str2",...]}  (CF accepts batch natively)
   *   reply : {result: {data: [[float,...],...], shape: [n, dim]}, success}
   *
   * Supported model_ids (V30 catalog):
   *   - @cf/baai/bge-m3              (multilingual, 1024-d)
   *   - @cf/baai/bge-large-en-v1.5   (English, 1024-d)
   *   - @cf/baai/bge-base-en-v1.5    (English, 768-d)
   *   - @cf/baai/bge-small-en-v1.5   (English, 384-d)
   *
   * Neurons-per-call: ~5-10 per text (small relative to image-gen).
   */
  async embed(
    apiKey: string,
    modelId: string,
    input: string[],
    _options?: EmbedOptions,
  ): Promise<EmbedResult> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input }),
    }, 30000);
    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json() as any; msg = e.errors?.[0]?.message ?? msg; } catch {}
      throw new Error(`Cloudflare embed API error ${res.status}: ${msg}`);
    }
    const data = await res.json() as { result?: { data?: number[][], shape?: number[] } };
    const vectors = data.result?.data ?? [];
    const dimensions = vectors[0]?.length ?? 0;
    // CF returns HTTP 200 even when the daily neuron cap is exhausted — the
    // body comes back with missing, empty, or ragged vectors instead of a
    // 429. Detect a short/empty/ragged batch and surface it as a quota error:
    // "quota" makes it retryable (cascade), "daily" classifies it as
    // rate_limit_day so the CF key cools until UTC midnight.
    if (vectors.length !== input.length || dimensions === 0
        || vectors.some(v => !Array.isArray(v) || v.length !== dimensions)) {
      throw new Error(
        `Cloudflare embed API: incomplete response (daily neuron quota likely exhausted) — `
        + `got ${vectors.length}/${input.length} vectors from ${modelId}`,
      );
    }
    // CF doesn't report token usage; estimate ~4 chars/token for the joined input
    const promptTokens = Math.ceil(input.reduce((s, t) => s + t.length, 0) / 4);
    return { vectors, promptTokens, dimensions };
  }

  /**
   * Text-to-speech via Cloudflare Workers AI MeloTTS.
   *
   * Endpoint: POST .../ai/run/@cf/myshell-ai/melotts
   *   body  : {"prompt": <text>, "lang": "en"|"es"|"fr"|"zh"|"ja"|"ko"}
   *   reply : JSON {"audio": "<base64 mp3>"} (NOT binary stream)
   *
   * OpenAI's /v1/audio/speech contract uses `voice` for tone selection; for
   * MeloTTS we re-purpose it as the language selector since the model ships
   * fixed voices per language. Default lang='en'. Other OpenAI voices
   * (alloy/echo/...) silently fall through to English.
   *
   * Response format: only MP3. Other formats throw a 400 to match OpenAI
   * behavior of explicit failure on unsupported types.
   */
  async synthesizeSpeech(
    apiKey: string,
    modelId: string,
    input: string,
    options?: TtsOptions,
  ): Promise<TtsResult> {
    if (options?.responseFormat && options.responseFormat !== 'mp3') {
      throw new Error(`MeloTTS only supports response_format='mp3' (got '${options.responseFormat}')`);
    }
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

    // Map OpenAI voice -> melotts lang. Recognized OpenAI voice names default
    // to 'en'; if caller already passes an ISO lang code (en/es/fr/zh/ja/ko)
    // honor it. Anything else falls back to 'en'.
    const langSet = new Set(['en', 'es', 'fr', 'zh', 'ja', 'ko']);
    const lang = options?.voice && langSet.has(options.voice.toLowerCase())
      ? options.voice.toLowerCase()
      : 'en';

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: input, lang }),
    }, 30000);

    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json() as any; msg = e.errors?.[0]?.message ?? msg; } catch {}
      throw new Error(`Cloudflare TTS API error ${res.status}: ${msg}`);
    }
    const data = await res.json() as { result?: { audio?: string }, audio?: string };
    const b64 = data.result?.audio ?? data.audio;
    if (!b64) throw new Error(`Cloudflare TTS API: empty audio response from ${modelId}`);
    const buf = Buffer.from(b64, 'base64');
    // MeloTTS docs claim MP3 but actually return RIFF/WAV in 2026. Sniff
    // first 4 bytes: 'RIFF' (52494646) -> WAV; 'ID3 ' (494433) or MPEG sync
    // (ff e0-ff) -> MP3.
    const head = buf.slice(0, 4).toString('hex').toLowerCase();
    const mimeType: 'audio/wav' | 'audio/mpeg' = head.startsWith('52494646') ? 'audio/wav' : 'audio/mpeg';
    return { audio: buf, mimeType };
  }
}
