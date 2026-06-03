# MyLLM Vision (Multimodal) Plan

Hedef: OpenAI-uyumlu `content` array (text + image_url) ile vision-capable
modellere routing. Sync proxy + Batch API ortak.

> Bu doc tam spec — kod yazımından önce. Faz 1 = MVP (base64 + URL passthrough).

---

## 0. Kapsam

- **Giriş formatı**: OpenAI standardı:
  ```json
  {
    "content": [
      {"type":"text","text":"Bu görselde ne var?"},
      {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/..."}}
    ]
  }
  ```
- `image_url.url`: `data:<mime>;base64,<...>` veya `https://...`. Diğer
  şemalar (file://, blob:) reddedilir.
- `detail` parametresi ("low"/"high") OpenAI'da var; sağlayıcı bazında işlenir,
  çoğu yoksay. Şemada kabul edilir, passthrough.
- **Çıkış**: standart chat-completion; vision-specific delta yok.
- Streaming: vision input + stream OK; provider stream'i pass-through.
- Tool calling + vision birlikte: spec olarak yasak değil; OR/Gemini destekler.
- Batch API: aynı schema, image item de batch'lenebilir.

Faz 2 (sonra): image-only via `file_data` URL (Gemini), `detail:low` resize
hint, output image (image-gen modelleri — şu an katalogda yok, gerek yok).

---

## 1. Şema (Zod)

`server/src/lib/runChatCompletion.ts`:

```ts
const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string()
      .refine(u => u.startsWith('data:image/') || u.startsWith('https://') || u.startsWith('http://'),
              'image_url.url must be data:image/* or http(s)://'),
    detail: z.enum(['auto','low','high']).optional(),
  }),
});

const contentPartSchema = z.union([textPartSchema, imageUrlPartSchema]);

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(contentPartSchema).min(1)]),
  name: z.string().optional(),
});
// system / assistant / tool messages keep content: z.string().
```

`shared/types.ts`:

```ts
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto'|'low'|'high' } };

export type ChatMessageContent = string | ChatContentPart[];
```

Helper:
```ts
export function isMultimodal(messages: ChatMessage[]): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
}
```

---

## 2. DB migration V11

`migrateModelsV11(db)` in `server/src/db/index.ts`:

```sql
ALTER TABLE models ADD COLUMN vision_capable INTEGER NOT NULL DEFAULT 0;
```
(better-sqlite3 `ALTER TABLE … ADD COLUMN` idempotency: wrap in try/catch
to handle "duplicate column name" on re-run.)

Flag bilinen multimodal rows:

| Platform | model_id | Notlar |
|---|---|---|
| google | gemini-2.5-flash | resmi vision |
| google | gemini-2.5-flash-lite | resmi vision |
| google | gemini-3-flash-preview | resmi |
| google | gemini-3.1-pro-preview | resmi |
| google | gemini-3.1-flash-lite-preview | resmi |
| groq | meta-llama/llama-4-scout-17b-16e-instruct | multimodal |
| sambanova | Llama-4-Maverick-17B-128E-Instruct | multimodal |
| cloudflare | @cf/meta/llama-4-scout-17b-16e-instruct | multimodal |
| openrouter | qwen/qwen3-coder:free | not vision actually, skip |
| openrouter | minimax/minimax-m2.5:free | vision yes |
| openrouter | meta-llama/llama-3.3-70b-instruct:free | hayır |

Final liste (live-probe ile teyit edilecek, plan'da geçici):
- google: gemini-2.5-flash, gemini-2.5-flash-lite, gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.1-flash-lite-preview
- groq: meta-llama/llama-4-scout-17b-16e-instruct
- sambanova: Llama-4-Maverick-17B-128E-Instruct
- cloudflare: @cf/meta/llama-4-scout-17b-16e-instruct, @cf/moonshotai/kimi-k2.5, @cf/moonshotai/kimi-k2.6
- openrouter: minimax/minimax-m2.5:free

V12 daha sonra probe ile düzeltme yapar.

---

## 3. Routing

`runChatCompletion.ts` → `routeRequest` çağrısına 4. parametre
`requireVision: boolean`:

```ts
export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  requireVision = false,
): RouteResult
```

`routeRequest` içinde model row sorgusu:
```ts
const model = db.prepare(
  requireVision
    ? 'SELECT * FROM models WHERE id = ? AND enabled = 1 AND vision_capable = 1'
    : 'SELECT * FROM models WHERE id = ? AND enabled = 1'
).get(entry.model_db_id);
```

Vision request + preferredModelDbId verilmişse: pinned model vision-capable
değilse hata değil, **vision-capable ilk modele** auto-route.

Token estimation bump:
```ts
const imageCount = messages.reduce((n, m) =>
  Array.isArray(m.content)
    ? n + m.content.filter(p => p.type === 'image_url').length
    : n, 0);
const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000) + imageCount * 1000;
```
(1000 token per image — kaba; OpenAI low=85, high=170-765; sağlayıcı farkları var.
Konservatif tahmin → routing daha güvenli karar.)

---

## 4. Provider transformers

### 4.1 OpenAI-compat (Groq, SambaNova, Cerebras, OpenRouter, Cloudflare, Mistral, Zhipu, GitHub)

OpenAI standardı zaten array content kabul ediyor → **passthrough**. Mevcut
`openai-compat.ts` body'i `JSON.stringify(messages)` ile geçiriyor; ekstra iş yok.
Yalnızca aşağıdaki kontrol: array content içinde her item düz JSON-serializable.
Görsel base64 data URL ise binary olmadığı için fetch limitine takılmaz.

### 4.2 Google (Gemini)

`google.ts:translateMessages` (mevcut). Şu an `content` string varsayıyor.

Yeni:
```ts
async function translatePart(part: ChatContentPart): Promise<GoogleApiPart> {
  if (part.type === 'text') return { text: part.text };
  // image_url
  const url = part.image_url.url;
  if (url.startsWith('data:')) {
    const m = url.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!m) throw new Error('invalid data URL');
    return { inline_data: { mime_type: m[1], data: m[2] } };
  }
  // http(s) — fetch + base64
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const ct = res.headers.get('content-type') ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5 * 1024 * 1024) throw new Error('image too large (>5MB)');
  return { inline_data: { mime_type: ct, data: buf.toString('base64') } };
}
```

`translateMessages` async olur → tüm callsite (`chatCompletion`,
`streamChatCompletion`) zaten async; await ekle.

Multi-image: tek user message içinde N image_url, Gemini `parts: [text, img, img, text, ...]` sırasıyla destekler. Sıra korunur.

### 4.3 Cohere

Cohere chat API'da multimodal yok (mevcut command-r-plus, command-a). Skip;
`vision_capable=0` → router zaten seçmez.

### 4.4 Cloudflare

`@cf/meta/llama-4-scout-17b-16e-instruct` ve `@cf/moonshotai/kimi-k2.*` OpenAI-uyumlu
endpoint'i (`/v1/chat/completions`) ile array content kabul eder. Cloudflare
provider'ı (cloudflare.ts) mevcut OpenAI-compat'i kullanıyorsa otomatik;
custom yol varsa kontrol.

---

## 5. Limitler ve güvenlik

- **Max image bytes**: 5MB tek görsel, 4 görsel max per request → 20MB
  toplam. data URL base64 ~ 1.33× payload boyutu; runChatCompletion
  pre-flight check.
- **HTTP fetch timeout**: 15s.
- **HTTP-only URL'leri reddet**: file://, ftp://, blob: → 400.
- **SSRF koruması**: localhost / 127.0.0.1 / 169.254.169.254 / 10.0.0.0/8 / 192.168.0.0/16
  → 400 (sağlayıcıya gönderilmeden önce DNS resolve + private check).
- **JSON parser**: `/v1/chat/completions` mevcut 1MB → vision için 25MB
  yetersiz. `app.ts` özel mount:
  ```ts
  app.use('/v1/chat/completions', express.json({ limit: '25mb' }));
  ```
- **Batch**: zaten 6mb. Bump to `30mb` toplam batch için.
- Provider 400 ("image too large"): retryable değil; consumer hatası → 400.

---

## 6. Schema kabul edilecek messages örnek

```json
{
  "messages": [
    {"role":"system","content":"Cevabı Türkçe ver."},
    {"role":"user","content":[
      {"type":"text","text":"Görseldeki yazıyı oku."},
      {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw..."}}
    ]}
  ]
}
```

Hata mesajları:
- `content` array boş → 400 `at least one content part required`
- `image_url.url` invalid scheme → 400 `image_url.url must be data:image/* or http(s)://`
- system/assistant/tool array content → 400 `only user messages support array content`

(Faz 2'de assistant array content destek istenirse açılır.)

---

## 7. Token estimation

`estimateImageTokens(part)` heuristic:
```ts
function estimateImageTokens(p: ImageUrlPart): number {
  const detail = p.image_url.detail ?? 'auto';
  if (detail === 'low') return 100;
  if (detail === 'high') return 800;
  // auto: 500 mid-estimate
  return 500;
}
```

`canUseTokens` çağrısına input olarak gider. TPD/TPM cap rejection için.

---

## 8. Test planı

| Dosya | Test |
|---|---|
| `__tests__/lib/schema-vision.test.ts` | 1) array content user OK 2) string content user OK 3) array content boş → 400 4) image_url scheme reject 5) system + array → 400 |
| `__tests__/services/router-vision.test.ts` | 1) vision request → only vision_capable rows 2) non-vision request → all enabled 3) preferredModelDbId + vision → auto-route if pinned-not-vision 4) no vision-capable enabled → throws |
| `__tests__/providers/google-vision.test.ts` | 1) data URL → inline_data parts 2) http URL → fetch + base64 (mock fetch) 3) invalid scheme → throws 4) >5MB → throws 5) text+image+text ordering preserved |
| `__tests__/providers/openai-compat-vision.test.ts` | 1) array content passthrough to body 2) tools + vision both forwarded |
| `__tests__/routes/proxy-vision.test.ts` | E2E: POST /v1/chat/completions w/ array content → router picks vision model → mock provider chatCompletion called w/ array content. |
| `__tests__/lib/isMultimodal.test.ts` | helper detect array image part |

Total: ~25-30 yeni test.

---

## 9. Migration sırası (kodda)

1. shared/types.ts — `ChatContentPart`, `ChatMessageContent` union
2. server/src/lib/runChatCompletion.ts — schema + isMultimodal + normalizeMessages
3. server/src/db/index.ts — migrateModelsV11 + V12 flag list
4. server/src/services/router.ts — requireVision parametresi + SQL gate
5. server/src/providers/google.ts — async translateMessages + image part handler + SSRF check helper
6. server/src/providers/openai-compat.ts — content array passthrough (no-op kontrol)
7. server/src/app.ts — body parser limit bump on /v1/chat/completions
8. tests
9. CLAUDE.md + API-KULLANIM.md güncel: vision bölümü

---

## 10. Rollout

1. Local impl + tests pass
2. `npm run build && scripts/deploy.sh`
3. Smoke test: 1 data URL + Gemini Flash
4. Smoke test: 1 https URL + Llama-4-Scout (Groq)
5. CLAUDE.md + API-KULLANIM.md commit
6. your app notify: vision input desteği açık

---

## 11. Faz 2 (sonra)

- Output image (image-gen) — şu an free tier'da yok, skip
- File API: 7-day storage + reference (Gemini Files), skip
- Audio input (Gemini Live, Groq Whisper) — ayrı plan
- Streaming vision mid-stream — provider farkları, test+iterate

---

## 12. Risk + mitigation

| Risk | Mitigation |
|---|---|
| Provider 400 "image format unsupported" | Schema MIME whitelist: jpeg/png/webp/gif |
| Memory baloon (büyük base64 in-memory) | 5MB/image hard cap + global 20MB |
| SSRF via http URL | Private-IP block list |
| Auto-route vision model day-quota'da → cascade fallback non-vision'a → 400 | Cascade içinde non-vision row atla, sadece vision_capable kalsın |
| Mock provider testleri için image fetch'i sahte | vi.spyOn(global, 'fetch') ile zaten kontrol |
