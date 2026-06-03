import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@myllm/shared/types.js';
import { BaseProvider, type ImageGenerationOptions, type ImageGenerationResult, type ImageEditOptions } from './base.js';
import { storeImage } from '../services/imageStorage.js';

const POLLINATIONS_TIMEOUT_MS = Number(process.env.MYLLM_POLLINATIONS_TIMEOUT_MS ?? 60_000);
const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';

/**
 * Pollinations.ai keyless image generation.
 *
 * Endpoint: GET https://image.pollinations.ai/prompt/<url-encoded-prompt>?model=...
 * Auth: none (free, IP rate-limited ~5 req/min)
 * Response: binary JPEG (default) or PNG
 *
 * model_id stored in DB as "pollinations/<base>" so routing keeps a unique
 * namespace; the URL only needs the base ("flux", "turbo", "flux-realism",
 * "flux-anime").
 */
export class PollinationsProvider extends BaseProvider {
  readonly platform = 'pollinations' as const;
  readonly name = 'Pollinations.ai';
  readonly requiresApiKey = false;

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw new Error('Pollinations.ai does not support chat completion');
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw new Error('Pollinations.ai does not support streaming');
  }

  async validateKey(_apiKey: string): Promise<boolean> {
    // No key to validate. Treat as healthy so the health checker doesn't
    // disable the synthetic row.
    return true;
  }

  async generateImage(
    _apiKey: string,
    modelId: string,
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    const [w, h] = (options?.size ?? '1024x1024').split('x').map(Number);
    const baseModel = modelId.replace(/^pollinations\//, '');
    const n = Math.max(1, Math.min(options?.n ?? 1, 4));

    const callOnce = async (idx: number): Promise<string> => {
      const params = new URLSearchParams({
        width: String(Number.isFinite(w) ? w : 1024),
        height: String(Number.isFinite(h) ? h : 1024),
        model: baseModel,
        nologo: 'true',
        private: 'true',
      });
      if (options?.seed != null) params.set('seed', String(options.seed + idx));
      if (options?.negative_prompt) params.set('negative_prompt', options.negative_prompt);

      const url = `${POLLINATIONS_BASE}${encodeURIComponent(prompt)}?${params.toString()}`;
      const res = await this.fetchWithTimeout(url, { method: 'GET' }, POLLINATIONS_TIMEOUT_MS);
      if (!res.ok) {
        let msg = res.statusText;
        try { const e = await res.text(); msg = e.slice(0, 200) || msg; } catch { /* binary */ }
        throw new Error(`Pollinations.ai error ${res.status}: ${msg}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    };

    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await callOnce(i));
    return { b64Images: out, mimeType: 'image/jpeg' };
  }

  /**
   * Image-to-image via Pollinations.ai flux `?image=<url>` param.
   *
   * Pipeline: caller supplies source as data URL or http(s) URL ->
   *   - data URL: decode, persist via storeImage() to get a public signed URL
   *               with 2h expiry (Pollinations only needs to fetch it once);
   *   - http URL: pass through (must be publicly reachable from Pollinations).
   * Then GET image.pollinations.ai/prompt/<prompt>?model=flux&image=<srcUrl>
   * and return the binary PNG.
   *
   * Mask is ignored (Pollinations doesn't accept one). `strength` clamped 0-1
   * but Pollinations doesn't expose it either — passed through as
   * `?image_strength=` (best-effort; param may be no-op upstream).
   */
  async editImage(
    _apiKey: string,
    modelId: string,
    opts: ImageEditOptions,
  ): Promise<ImageGenerationResult> {
    const [w, h] = (opts.size ?? '1024x1024').split('x').map(Number);
    const baseModel = modelId.replace(/^pollinations\//, '');
    const n = Math.max(1, Math.min(opts.n ?? 1, 4));

    // Resolve source -> public URL
    let srcUrl: string;
    if (opts.image.startsWith('data:')) {
      const m = opts.image.match(/^data:image\/([\w+.-]+);base64,(.+)$/);
      if (!m) throw new Error('invalid data URL');
      const mime = `image/${m[1].toLowerCase().replace('jpg', 'jpeg')}`;
      const stored = storeImage(m[2], mime, {
        platform: 'pollinations',
        modelId: `${modelId}:src`,
        expiresInHours: 2,
      });
      srcUrl = stored.url;
    } else if (opts.image.startsWith('http://') || opts.image.startsWith('https://')) {
      // Block private-range URLs for SSRF safety
      const u = new URL(opts.image);
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host.endsWith('.local') || /^(10|127|169\.254|192\.168)\./.test(host)) {
        throw new Error('image url host blocked (private/loopback)');
      }
      srcUrl = opts.image;
    } else {
      throw new Error('image must be data:image/* or http(s)://');
    }

    const callOnce = async (idx: number): Promise<string> => {
      const params = new URLSearchParams({
        width: String(Number.isFinite(w) ? w : 1024),
        height: String(Number.isFinite(h) ? h : 1024),
        model: baseModel,
        image: srcUrl,
        nologo: 'true',
        private: 'true',
      });
      if (opts.seed != null) params.set('seed', String(opts.seed + idx));
      if (opts.strength != null) params.set('image_strength', String(Math.max(0, Math.min(1, opts.strength))));

      const url = `${POLLINATIONS_BASE}${encodeURIComponent(opts.prompt)}?${params.toString()}`;
      const res = await this.fetchWithTimeout(url, { method: 'GET' }, POLLINATIONS_TIMEOUT_MS);
      if (!res.ok) {
        let msg = res.statusText;
        try { const e = await res.text(); msg = e.slice(0, 200) || msg; } catch { /* binary */ }
        throw new Error(`Pollinations.ai i2i error ${res.status}: ${msg}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    };

    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await callOnce(i));
    return { b64Images: out, mimeType: 'image/jpeg' };
  }

  // Unused on this provider but required by abstract base — keeping the
  // signature reachable via a noop assignment.
  protected _unusedMessages(_: ChatMessage[]) { /* noop */ }
}
