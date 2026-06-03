# MyLLM Image Generation Plan (Faz 1 = CF)

Hedef: OpenAI-uyumlu `/v1/images/generations` endpoint'i. Caller PNG/JPEG
base64 alır. Routing + cooldown + cascade mantığı mevcut sistemle aynı —
sadece text yerine image üretim. Faz 1'de yalnız Cloudflare Workers AI; Faz 2'de
Pollinations.ai + Zhipu CogView.

> Pattern: vision/structured-output ile aynı. Schema → DB flag → router →
> provider → tests → docs.

---

## 0. Genel ilkeler

- **OpenAI-uyumluluk**: `POST /v1/images/generations`. Body alanları:
  `prompt`, `model?`, `n?` (1..4), `size?` ("512x512" | "1024x1024" | "1024x768"
  | "768x1024"), `response_format?` ("b64_json" default | "url"), `quality?`
  ("standard" | "hd"), `negative_prompt?` (OpenAI ext), `seed?` (OpenAI ext).
- **Auto-route** model yoksa. Default: en hızlı model (`@cf/bytedance/stable-diffusion-xl-lightning`).
- **Cascade**: bir model rate-limit/quota'ya takılırsa `routeRequest` modality='image_gen'
  filter ile bir sonraki image-gen modeli dener.
- **Token muhasebesi**: image gen token tabanlı değil — Neurons. Her başarılı
  isteğe model row'undan `neurons_per_image` × N kadar tahmini "tokens" muhasebesi
  yapılır (existing `usage_counters` schema'ya uyum).
- **Auth**: Aynı Bearer unified key.
- **Limitler**: Default `n=1`, max `n=4`, max prompt 4000 char, max negative_prompt 1000.
- **Response**: data URL inline (`data:image/png;base64,...`) veya pure base64
  (OpenAI standardı: `b64_json`). `url` formatı Faz 2 (storage gerekir);
  Faz 1'de `url` istenirse 400 `url_not_supported_in_phase_1`.

---

## 1. Endpoint spec

### 1.1 İstek

```http
POST /v1/images/generations
Authorization: Bearer <UNIFIED_API_KEY>
Content-Type: application/json

{
  "prompt": "a kawaii cat in a parka, soft pastel",
  "model": "flux-1-schnell",            // opsiyonel — auto-route
  "n": 1,                                // default 1, max 4
  "size": "1024x1024",                   // default "1024x1024"
  "response_format": "b64_json",         // default "b64_json"; "url" 400'lar
  "negative_prompt": "blurry, low quality",  // opsiyonel
  "seed": 42,                            // opsiyonel deterministik
  "quality": "standard"                  // standard|hd, sağlayıcıya iletilir
}
```

### 1.2 Yanıt 200

```json
{
  "created": 1779285600,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": null
    }
  ],
  "_routed_via": {
    "platform": "cloudflare",
    "model": "@cf/bytedance/stable-diffusion-xl-lightning"
  }
}
```

Headers:
- `X-Routed-Via: cloudflare/@cf/...`
- `X-Fallback-Attempts: <N>` (cascade derinliği)

### 1.3 Hatalar

| HTTP | code | Anlam |
|---|---|---|
| 400 | `invalid_request_error` | zod parse fail (prompt boş, n>4, vb.) |
| 400 | `model_not_found` | model pin geçersiz |
| 400 | `model_not_image_gen` | model image-gen değil (modality != image_gen) |
| 400 | `url_not_supported_in_phase_1` | `response_format=url` |
| 401 | `authentication_error` | Bearer eksik/yanlış |
| 429 | `rate_limit_error` | tüm image-gen modelleri cooldown |
| 502 | `provider_error` | non-retryable upstream |

---

## 2. DB schema V15

`server/src/db/index.ts`:

```sql
ALTER TABLE models ADD COLUMN modality TEXT NOT NULL DEFAULT 'text';
-- modality enum: 'text' (chat) | 'image_gen' | 'embedding' (future)
ALTER TABLE models ADD COLUMN neurons_per_call INTEGER;
```

Idempotent (try/catch on duplicate).

### 2.1 Seed image-gen rows

| platform | model_id | display_name | neurons_per_call | speed_rank | priority | notes |
|---|---|---|---|---|---|---|
| cloudflare | `@cf/black-forest-labs/flux-1-schnell` | FLUX.1 Schnell (CF) | 80 | 3 | top | 4-step, best quality/speed balance |
| cloudflare | `@cf/bytedance/stable-diffusion-xl-lightning` | SDXL Lightning (CF) | 100 | 4 | 2 | 8-step, fast |
| cloudflare | `@cf/lykon/dreamshaper-8-lcm` | Dreamshaper 8 LCM (CF) | 40 | 2 | 3 | 4-step LCM, cheapest |
| cloudflare | `@cf/stabilityai/stable-diffusion-xl-base-1.0` | SDXL Base (CF) | 600 | 9 | 5 | 30-step, highest quality, slowest |
| cloudflare | `@cf/runwayml/stable-diffusion-v1-5-inpainting` | SD 1.5 Inpaint (CF) | 80 | 6 | 4 | inpainting variant, special use |

Tüm rows: `vision_capable=0`, `supports_json_mode=0`, `is_reasoning=0`,
`modality='image_gen'`, `monthly_token_budget='~10-20M'` (neurons × calls
approximate), `enabled=1`, `rpm_limit=null`, `rpd_limit=null`,
`tpd_limit=null`, `context_window=null`.

Fallback chain'e eklenir; auto-route'ta modality filter ile text isteklerinden
gizlenir, image isteklerinde önce gelir.

---

## 3. Types + Schema

`shared/types.ts`:

```ts
export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: '512x512' | '1024x1024' | '1024x768' | '768x1024';
  response_format?: 'b64_json' | 'url';
  negative_prompt?: string;
  seed?: number;
  quality?: 'standard' | 'hd';
}

export interface ImageGenerationData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string | null;
}

export interface ImageGenerationResponse {
  created: number;
  data: ImageGenerationData[];
  _routed_via?: { platform: string; model: string };
}
```

`server/src/lib/runImageGeneration.ts`:

```ts
export const imageGenerationSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.enum(['512x512','1024x1024','1024x768','768x1024']).optional(),
  response_format: z.enum(['b64_json','url']).optional(),
  negative_prompt: z.string().max(1000).optional(),
  seed: z.number().int().optional(),
  quality: z.enum(['standard','hd']).optional(),
});
```

---

## 4. Provider integration

### 4.1 base.ts CompletionOptions yetmiyor — yeni method

`server/src/providers/base.ts`:

```ts
export interface ImageGenerationOptions {
  n?: number;
  size?: string;
  negative_prompt?: string;
  seed?: number;
  quality?: 'standard' | 'hd';
}

export interface ImageGenerationResult {
  b64Images: string[];   // base64 PNG bytes (no data: prefix)
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export abstract class BaseProvider {
  // ... existing
  // Default: image-gen not supported. Providers override.
  async generateImage(_apiKey: string, _modelId: string, _prompt: string, _options?: ImageGenerationOptions): Promise<ImageGenerationResult> {
    throw new Error(`Provider ${this.platform} does not support image generation`);
  }
}
```

### 4.2 Cloudflare implementation

Endpoint: `https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/run/<model>`

Body (CF AI):
```json
{
  "prompt": "...",
  "negative_prompt": "...",   // sd-xl-* destekler
  "num_steps": 4,             // flux-schnell=4, lightning=8, base=30
  "guidance": 7.5,
  "seed": 42,
  "width": 1024,
  "height": 1024
}
```

Response: binary PNG bytes (raw octet-stream). MyLLM base64'ler.

```ts
// CloudflareProvider.generateImage
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
const [w, h] = (options?.size ?? '1024x1024').split('x').map(Number);
const numSteps = numStepsForModel(modelId);
const body = { prompt, negative_prompt: options?.negative_prompt, num_steps: numSteps, seed: options?.seed, width: w, height: h };
const res = await fetchWithTimeout(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60_000);
if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  throw new Error(`Cloudflare image API error ${res.status}: ${err.errors?.[0]?.message ?? res.statusText}`);
}
const buf = Buffer.from(await res.arrayBuffer());
return { b64Images: [buf.toString('base64')], mimeType: 'image/png' };
```

Timeout 60s (image gen text'ten yavaş).

`n>1` Faz 1'de N kez seri çağrı (CF AI tek image döner). Faz 2'de paralel.

---

## 5. Router

`routeRequest(estimatedTokens, skipKeys, preferredModelDbId, requireVision,
requireJsonMode, excludeReasoning, modality)`:

```sql
WHERE id = ? AND enabled = 1
  {modality === 'image_gen' ? AND modality = 'image_gen' : AND (modality = 'text' OR modality IS NULL)}
  ...
```

Text isteklerinde varsayılan: `modality IN ('text', NULL)` — eski rows
modality NULL olabilir migration sırasında, ama V15 default 'text' set ediyor.

Image isteklerinde: `modality = 'image_gen'`.

Cooldown/usage_counters aynı sistemle çalışır — model+key+gün kombinasyonu
şekilli.

### 5.1 runImageGeneration core

```ts
export async function runImageGeneration(parsed: ImageGenerationRequest): Promise<ImageGenerationRunResult> {
  // 1. resolve preferred model (modality='image_gen' gate)
  // 2. for attempt 0..MAX_RETRIES: routeRequest(modality='image_gen')
  // 3. recordRequest + provider.generateImage(apiKey, modelId, prompt, options)
  // 4. recordTokens with neurons_per_call * n (approximate)
  // 5. catch → cooldown classify → cascade
  // 6. logRequest with response_format='image' marker (or a new field)
}
```

`logRequest`'e yeni flag eklemek yerine `modality` kolonu kullanılır
(`requests.modality TEXT`). V15 migration aynı zamanda requests'e modality ekler.

---

## 6. Endpoint route

`server/src/routes/images.ts`:

```ts
export const imagesRouter = Router();
imagesRouter.post('/generations', async (req, res) => {
  if (!authenticate(req, res)) return;

  const parsed = imageGenerationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400)...;

  if (parsed.data.response_format === 'url') {
    return res.status(400).json({ error: { message: 'response_format=url not supported in phase 1', type: 'invalid_request', code: 'url_not_supported_in_phase_1' } });
  }

  try {
    const result = await runImageGeneration(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: result.images.map(b64 => ({ b64_json: b64, revised_prompt: null })),
      _routed_via: { platform: result.routedPlatform, model: result.routedModel },
    });
  } catch (err) {
    // same error classification as runChatCompletion
  }
});
```

`server/src/app.ts`:
```ts
app.use('/v1/images', express.json({ limit: '500kb' })); // prompt küçük, output binary değil
app.use('/v1/images', imagesRouter);
```

---

## 7. UI (Faz 1.5, opsiyonel)

Playground sayfasına "Image" sekmesi: prompt + size dropdown + model dropdown
+ "Generate" butonu + base64 preview + download. Faz 1 sonu ekle, kritik değil.

---

## 8. Limitler & güvenlik

| Limit | Default | Override env |
|---|---|---|
| max prompt char | 4000 | `MYLLM_IMAGE_MAX_PROMPT` |
| max n | 4 | `MYLLM_IMAGE_MAX_N` |
| timeout per image | 60s | `MYLLM_IMAGE_TIMEOUT_MS` |
| body parser limit | 500kb | static |

NSFW / safety: CF AI provider tarafında otomatik (CF policy). MyLLM ek filter
yapmaz — caller sorumlu.

---

## 9. Tests (~30 yeni)

| Dosya | Test |
|---|---|
| `__tests__/lib/schema-image-gen.test.ts` | 1) prompt zorunlu, max 4000 2) n 1..4 3) size enum 4) response_format=url accepted at schema but rejected at endpoint 5) negative_prompt 6) seed integer |
| `__tests__/services/router-image-gen.test.ts` | 1) modality='image_gen' yalnız image rows döner 2) text request image row almaz 3) pin chat model + image → drop pin 4) no image-gen-capable model → throws |
| `__tests__/db/migrate-v15-imagegen.test.ts` | 1) modality column exists 2) flux/sdxl-lightning/dreamshaper rows seeded with modality='image_gen' 3) text rows default modality='text' |
| `__tests__/providers/cloudflare-imagegen.test.ts` | 1) generateImage builds correct CF URL + body 2) binary response → base64 3) n>1 calls multiple times 4) timeout 60s 5) error 4xx propagates |
| `__tests__/routes/images.test.ts` | E2E: 1) 401 without key 2) 400 schema fail 3) 400 url not supported 4) 200 with mock CF + b64_json data 5) X-Routed-Via header 6) cascade to next model on 429 |

---

## 10. Dosya listesi & LOC

| Dosya | Yeni/Edit | LOC |
|---|---|---|
| `docs/IMAGE-GEN-PLAN.md` | YENİ | ~250 |
| `shared/types.ts` | edit | +30 |
| `server/src/db/index.ts` | edit (V15 migration + seed) | +60 |
| `server/src/providers/base.ts` | edit (generateImage abstract) | +20 |
| `server/src/providers/cloudflare.ts` | edit (generateImage impl) | +80 |
| `server/src/services/router.ts` | edit (modality param) | +10 |
| `server/src/lib/runImageGeneration.ts` | YENİ | ~200 |
| `server/src/routes/images.ts` | YENİ | ~120 |
| `server/src/app.ts` | edit (mount) | +3 |
| `server/src/__tests__/{...} ` | YENİ (5 dosya) | ~400 |
| `CLAUDE.md` | edit (§10.d) | +40 |
| `API-KULLANIM.md` | edit (§13) | +90 |
| `docs/IMAGE-GEN-API.md` | YENİ (consumer doc) | ~150 |

**Toplam ~1450 LOC** (test + docs dahil), saf kod ~520.

---

## 11. Faz 2 (sonra)

- Pollinations.ai fallback (keysiz, anonymous endpoint)
- Zhipu CogView entegrasyonu
- Hugging Face Inference (eğer yeni anahtar gelirse)
- `response_format=url` (file storage + signed URL gerekir; S3/MinIO)
- Image edit endpoint (`/v1/images/edits` — img2img/inpainting)
- Image variations endpoint (`/v1/images/variations`)

---

## 12. Rollout

1. Local impl + 30 test pass
2. `bash scripts/deploy.sh`
3. Smoke test: `curl -X POST .../v1/images/generations -d '{"prompt":"a cat"}' -o /tmp/r.json && jq -r '.data[0].b64_json' /tmp/r.json | base64 -d > /tmp/cat.png`
4. CLAUDE.md + API-KULLANIM.md commit
5. your app + emlak ajan'a notify
