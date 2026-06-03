import { OpenAICompatProvider } from './openai-compat.js';
import type { ImageGenerationOptions, ImageGenerationResult } from './base.js';

const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const ZHIPU_IMAGE_TIMEOUT_MS = Number(process.env.MYLLM_ZHIPU_IMAGE_TIMEOUT_MS ?? 60_000);

/**
 * Zhipu / Z.ai provider. OpenAI-compatible for chat (handled by base class)
 * AND adds image generation via /images/generations (CogView family).
 *
 * Same anahtar that talks GLM-4.5-flash + GLM-4.7-flash on /chat/completions
 * is accepted on /images/generations, so we don't need a separate api_keys
 * row for image-gen.
 *
 * CogView /images/generations returns OpenAI-shaped `{ data: [{ url }] }`.
 * We fetch each url, base64-encode the bytes, and return them in the same
 * shape MyLLM uses for Cloudflare image-gen so callers get a uniform
 * response.
 */
export class ZhipuProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'zhipu',
      name: 'Zhipu AI',
      baseUrl: ZHIPU_BASE,
    });
  }

  async generateImage(
    apiKey: string,
    modelId: string,
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    const size = options?.size ?? '1024x1024';
    const n = Math.max(1, Math.min(options?.n ?? 1, 4));

    // Body: CogView accepts { model, prompt, size }. n + seed are not
    // documented universally — we iterate ourselves with prompt-only calls
    // when n>1 to keep behaviour consistent.
    const callOnce = async (): Promise<string> => {
      const body: Record<string, unknown> = { model: modelId, prompt, size };
      if (options?.negative_prompt) body.negative_prompt = options.negative_prompt;
      if (options?.seed != null) body.seed = options.seed;

      const res = await this.fetchWithTimeout(`${ZHIPU_BASE}/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, ZHIPU_IMAGE_TIMEOUT_MS);

      if (!res.ok) {
        let msg = res.statusText;
        try {
          const err = await res.json() as any;
          msg = err.error?.message ?? err.message ?? msg;
        } catch { /* */ }
        throw new Error(`Zhipu image API error ${res.status}: ${msg}`);
      }

      const data = await res.json() as { data?: Array<{ url?: string; b64_json?: string }> };
      const first = data.data?.[0];
      if (!first) throw new Error('Zhipu image API: empty data array');

      // Zhipu returns either b64_json or url. Prefer b64; otherwise fetch url.
      if (first.b64_json) return first.b64_json;
      if (!first.url) throw new Error('Zhipu image API: no url or b64_json in response');
      const imgRes = await this.fetchWithTimeout(first.url, { method: 'GET' }, ZHIPU_IMAGE_TIMEOUT_MS);
      if (!imgRes.ok) throw new Error(`Zhipu image url fetch ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      return buf.toString('base64');
    };

    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await callOnce());
    return { b64Images: out, mimeType: 'image/png' };
  }
}
