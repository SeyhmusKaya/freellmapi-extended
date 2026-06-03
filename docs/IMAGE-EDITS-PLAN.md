# MyLLM Image Edits / Variations (Image-to-Image) Plan

Hedef: `POST /v1/images/edits` (inpainting / img2img) ve
`POST /v1/images/variations` (style variation) endpoint'leri. OpenAI
standardı. Cloudflare Workers AI img2img + inpainting modellerini kullanır.

> Pattern: T2I (text-to-image) Faz 1-3 ile aynı — schema → DB flag →
> provider method → router gate → tests → docs.

---

## 0. Kapsam

**T2I (mevcut)**: prompt → image
**I2I (bu plan)**:
- **edits** (inpainting): prompt + image + mask → modified image
- **edits** (img2img): prompt + image → restyled image
- **variations**: image → new image (prompt opsiyonel, stil varyantı)

OpenAI uses:
- `POST /v1/images/edits` — `image`, `mask?`, `prompt`, `n?`, `size?`, `response_format?`
- `POST /v1/images/variations` — `image`, `n?`, `size?`, `response_format?`

Both multipart/form-data OR JSON (we support **JSON only** for Faz 1 —
multipart later if needed).

---

## 1. API Spec

### 1.1 POST /v1/images/edits

```json
{
  "prompt": "a kawaii cat wearing a red parka",
  "image": "data:image/png;base64,iVBORw0...",     // zorunlu (data URL veya http)
  "mask":  "data:image/png;base64,iVBORw0...",     // opsiyonel — inpainting için
  "model": "@cf/runwayml/stable-diffusion-v1-5-inpainting",  // opsiyonel
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json",                   // veya "url"
  "strength": 0.7,                                  // img2img: source'a sadakat (0..1)
  "seed": 42
}
```

- `image` zorunlu. `data:image/<jpg|png|webp>;base64,...` veya
  `https?://...`. SSRF guard + 5MB hard cap + MIME whitelist (T2I vision
  pattern reuse).
- `mask` varsa: inpainting (mask'in beyaz alanları yeniden çizilir).
- `mask` yoksa: img2img (tüm görsel `strength` kadar yeniden işlenir).
- `model` boşsa auto-route — `supports_img2img=1` veya
  `supports_inpainting=1` rows seçilir.
- `prompt` zorunlu (edits için).

### 1.2 POST /v1/images/variations

```json
{
  "image": "data:image/png;base64,iVBORw0...",
  "model": "@cf/lykon/dreamshaper-8-lcm",
  "n": 1,
  "size": "1024x1024",
  "strength": 0.5,
  "response_format": "b64_json"
}
```

Aynı schema'nın prompt'suz versiyonu. CF'de native "variations" endpoint
yok — img2img modelini boş veya generic prompt (`"high quality image"`) +
düşük strength ile çağırırız.

### 1.3 Yanıt

T2I ile aynı şema:
```json
{
  "created": 1779285600,
  "data": [{ "b64_json": "...", "revised_prompt": null }],
  "_routed_via": { "platform": "cloudflare", "model": "@cf/runwayml/stable-diffusion-v1-5-img2img" }
}
```

response_format=url ise mevcut imageStorage signed URL pipeline kullanılır.

---

## 2. Şema

`server/src/lib/runImageEdit.ts`:

```ts
export const imageEditSchema = z.object({
  prompt: z.string().min(1).max(4000),
  image: z.string().refine(u => u.startsWith('data:image/') || u.startsWith('http')),
  mask:  z.string().refine(...).optional(),
  model: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.enum(['512x512','1024x1024','1024x768','768x1024']).optional(),
  response_format: z.enum(['b64_json','url']).optional(),
  strength: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
});

export const imageVariationSchema = imageEditSchema.omit({ prompt: true, mask: true }).extend({
  prompt: z.string().max(4000).optional(),
});
```

---

## 3. DB V18

Yeni kolonlar:
```sql
ALTER TABLE models ADD COLUMN supports_img2img    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN supports_inpainting INTEGER NOT NULL DEFAULT 0;
```

Mevcut Cloudflare rows update:
| model_id | supports_img2img | supports_inpainting | Note |
|---|---|---|---|
| `@cf/runwayml/stable-diffusion-v1-5-inpainting` | 1 | 1 | dual purpose |
| `@cf/lykon/dreamshaper-8-lcm` | 1 | 0 | img2img only |
| `@cf/stabilityai/stable-diffusion-xl-base-1.0` | 1 | 0 | high quality |

Yeni row eklenebilir (CF native img2img):
- `@cf/runwayml/stable-diffusion-v1-5-img2img` — eğer CF AI'da geçerli model id ise (probe gerek; aksi takdirde mevcut SD-1.5-inpainting'i hem img2img hem inpainting için kullanırız).

FLUX schnell + SDXL lightning **img2img desteklemez** → flag 0.

---

## 4. Provider

`server/src/providers/base.ts`:
```ts
export interface ImageEditOptions {
  prompt: string;
  image: string;            // data URL veya http
  mask?: string;
  n?: number;
  size?: string;
  strength?: number;
  seed?: number;
}

export abstract class BaseProvider {
  // ...
  async editImage(
    _apiKey: string, _modelId: string, _opts: ImageEditOptions,
  ): Promise<ImageGenerationResult> {
    throw new Error(`${this.name} does not support image editing`);
  }
}
```

`server/src/providers/cloudflare.ts`:

CF AI img2img + inpainting body shape:
```json
{
  "prompt": "...",
  "image":     [byte_array_or_b64],   // CF docs: array of bytes (octets)
  "mask":      [byte_array],          // sadece inpainting
  "strength":  0.7,                    // img2img: 0..1
  "num_steps": 20,
  "guidance":  7.5,
  "width": 1024,
  "height": 1024,
  "seed": 42
}
```

CF AI accepts `image` as JSON array of bytes (e.g. `[137, 80, 78, ...]`).
Alternative: multipart upload. We use byte-array JSON since we already have
base64.

```ts
async editImage(apiKey, modelId, opts) {
  const { accountId, token } = this.parseKey(apiKey);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

  // image: data: URL veya http → bytes array
  const imageBytes = await this.loadImageBytes(opts.image);
  const maskBytes  = opts.mask ? await this.loadImageBytes(opts.mask) : undefined;
  const [w, h] = (opts.size ?? '1024x1024').split('x').map(Number);

  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    image: Array.from(imageBytes),
    strength: opts.strength ?? 0.7,
    num_steps: STEP_COUNT_BY_MODEL[modelId] ?? 20,
    width: w, height: h,
  };
  if (maskBytes) body.mask = Array.from(maskBytes);
  if (opts.seed != null) body.seed = opts.seed;

  const res = await this.fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, IMAGE_GEN_TIMEOUT_MS);
  // ... handle response same as generateImage
}
```

`loadImageBytes(url)`: data URL veya http(s) → Buffer. SSRF guard (mevcut
helper extract edilir).

---

## 5. Routing

`runImageEdit(parsed)`:

```ts
// modality='image_gen', PLUS filter on supports_img2img or supports_inpainting
const requireInpainting = !!parsed.mask;
route = routeRequest(estimatedNeurons, skipKeys, preferredModel,
                     false, false, false, 'image_gen',
                     { requireImg2Img: !requireInpainting, requireInpainting });
```

routeRequest yeni opsiyonel parametre `imageOps`:
```ts
if (imageOps?.requireInpainting) whereParts.push('supports_inpainting = 1');
else if (imageOps?.requireImg2Img) whereParts.push('supports_img2img = 1');
```

Tek bir Cloudflare modeli (SD-1.5-inpainting) hem img2img hem inpainting
yapıyor → cascade düşmez ama eklenebilir candidates'ler için açık kapı.

---

## 6. Endpoint route

`/v1/images/edits` ve `/v1/images/variations` — `images.ts` içine eklenir.

```ts
imagesRouter.post('/edits',      async (req, res) => { ... });
imagesRouter.post('/variations', async (req, res) => { ... });
```

Validation farklı schema, ortak run fonksiyonu (`runImageEdit`) — sadece
imageOps flag farklı ve variations'da prompt opsiyonel.

`app.ts` `/v1/images` body limit 25mb (image input yer kaplar).

---

## 7. Limitler

| Limit | Default | Override |
|---|---|---|
| max image bytes | 5MB | `MYLLM_IMAGE_INPUT_MAX_BYTES` |
| max mask bytes | 5MB | aynı |
| body parser | 25mb (mevcut /v1/images) | — |
| timeout/img | 60s (mevcut) | `MYLLM_IMAGE_TIMEOUT_MS` |
| MIME whitelist | png/jpg/webp/gif | shared with vision |

---

## 8. SSRF

`loadImageBytes(url)` paylaşılan helper — şu an Cloudflare provider ve
Google provider'da ayrı kopyalar var (fetchImageAsDataUrl /
fetchImageAsInlineData). Ortak yere taşımak gerek ama Faz 4'te;
şimdilik CF içinde duplicate kabul.

---

## 9. Tests

| Dosya | Test |
|---|---|
| `lib/schema-image-edit.test.ts` | 1) edit + variations zod accept/reject 2) image scheme guard 3) strength 0..1 |
| `providers/cloudflare-edit.test.ts` | 1) editImage builds body with byte array 2) mask passed for inpainting 3) strength forwarded 4) data URL vs http path 5) SSRF reject |
| `services/router-img2img.test.ts` | 1) requireInpainting → supports_inpainting=1 rows 2) requireImg2Img → supports_img2img=1 3) no candidate → 400 |
| `db/migrate-v18-img2img.test.ts` | columns exist + correct flags |
| `routes/images-edits.test.ts` | E2E edits + variations, b64_json + url responses |

---

## 10. Dosya listesi & LOC

| Dosya | LOC |
|---|---|
| `docs/IMAGE-EDITS-PLAN.md` | ~250 |
| `shared/types.ts` | +20 |
| `server/src/db/index.ts` (V18 migration) | +50 |
| `server/src/providers/base.ts` | +20 |
| `server/src/providers/cloudflare.ts` (editImage + loadImageBytes) | +110 |
| `server/src/services/router.ts` (imageOps param) | +15 |
| `server/src/lib/runImageEdit.ts` | YENİ ~180 |
| `server/src/routes/images.ts` (+ 2 endpoint) | +90 |
| Tests (5 dosya) | ~400 |
| `CLAUDE.md` + `API-KULLANIM.md` | +120 |
| **TOPLAM** | ~1255 |

---

## 11. Rollout

1. Local impl + tests 30+
2. `bash scripts/deploy.sh`
3. Smoke: real image upload + curl test
4. Docs commit
5. your app/emlak ajanı notify

---

## 12. Kapasite

CF img2img/inpainting ~80 neuron/resim — T2I ile aynı 90K/gün havuz.
Edits gece toplu çağrılırsa ~500-1000/gün ek; T2I ile bölüşür.
Pollinations img2img desteklemez (skip cascade).

---

## 13. Faz 4 (sonra)

- multipart/form-data desteği (OpenAI compat tam)
- `@cf/runwayml/stable-diffusion-v1-5-img2img` probe (varsa native img2img)
- Pollinations img2img endpoint denemesi
- Image outpainting (mask edge'i için)
- ControlNet (depth/edge guidance)
