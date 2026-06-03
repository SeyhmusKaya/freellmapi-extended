# MyLLM Structured Output (JSON Mode) Plan

Hedef: OpenAI `response_format: {type:"json_object"}` ve
`response_format: {type:"json_schema", json_schema:{...}}` istekleri
**yalnız structured-output destekleyen** modellere yönlendir; reasoning-only
modelleri (Kimi K2.5/K2.6, DeepSeek-R1, Magistral, vb.) JSON modunda
**route-time** dışla.

> Plan vision pattern'iyle aynı: schema → DB flag → router gate →
> provider passthrough → tests. Faz 1 = MVP.

## 0. Problem

Emlak ajanı raporu:

```json
{"choices":[{"finish_reason":"length",
  "message":{"content":null,"reasoning_content":"...Wait, the JSON should be: {\"city\":\"Ankara\"..."}}],
 "_routed_via":{"platform":"cloudflare","model":"@cf/moonshotai/kimi-k2.5"}}
```

- Kimi `max_tokens` bütçesini reasoning trace'ine harcadı
- `content: null`, ham JSON yarım `reasoning_content` içinde
- `openai-compat.ts:normalizeChoices` zaten `reasoning_content → content`
  fold ediyor ama `finish_reason=length` ile reasoning yarım → fold etse
  bile parse fail

## 1. Çözüm

Route-time'da `response_format=json_object|json_schema` görüldüğünde:
- `supports_json_mode = 1` olan modeller routing havuzuna girer
- `is_reasoning = 1` olanlar dışlanır (reasoning trace bütçe yer; structured
  çıktıda güvenilmez)

## 2. Schema (Zod)

`server/src/lib/runChatCompletion.ts`:

```ts
const jsonObjectFormatSchema = z.object({ type: z.literal('json_object') });
const jsonSchemaFormatSchema = z.object({
  type: z.literal('json_schema'),
  json_schema: z.object({
    name: z.string().min(1).optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }),
});
const textFormatSchema = z.object({ type: z.literal('text') }).optional();
const responseFormatSchema = z.union([
  jsonObjectFormatSchema,
  jsonSchemaFormatSchema,
  textFormatSchema,
]);

// chatCompletionSchema extend:
//   response_format: responseFormatSchema.optional(),
```

## 3. DB migration V12

```sql
ALTER TABLE models ADD COLUMN supports_json_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN is_reasoning      INTEGER NOT NULL DEFAULT 0;
```

(idempotent guard: try/catch on "duplicate column").

### 3.1 supports_json_mode = 1 (live-probe ile teyit edilecek):

| Platform | model_id |
|---|---|
| google | gemini-2.5-flash |
| google | gemini-2.5-flash-lite |
| google | gemini-2.5-pro |
| google | gemini-3-flash-preview |
| google | gemini-3.1-flash-lite-preview |
| google | gemini-3.1-pro-preview |
| groq | llama-3.3-70b-versatile |
| groq | meta-llama/llama-4-scout-17b-16e-instruct |
| groq | openai/gpt-oss-120b |
| groq | openai/gpt-oss-20b |
| groq | qwen/qwen3-32b |
| groq | llama-3.1-8b-instant |
| sambanova | Meta-Llama-3.3-70B-Instruct |
| sambanova | Llama-4-Maverick-17B-128E-Instruct |
| sambanova | gpt-oss-120b |
| sambanova | DeepSeek-V3.1 |
| sambanova | DeepSeek-V3.2 |
| sambanova | gemma-3-12b-it |
| cerebras | qwen-3-235b-a22b-instruct-2507 |
| cerebras | llama-4-maverick-17b-128e-instruct |
| mistral | mistral-large-latest |
| mistral | mistral-medium-latest |
| mistral | codestral-latest |
| mistral | devstral-latest |
| openrouter | openai/gpt-oss-120b:free |
| openrouter | openai/gpt-oss-20b:free |
| openrouter | qwen/qwen3-coder:free |
| openrouter | qwen/qwen3-next-80b-a3b-instruct:free |
| openrouter | meta-llama/llama-3.3-70b-instruct:free |
| openrouter | minimax/minimax-m2.5:free |
| openrouter | z-ai/glm-4.5-air:free |
| openrouter | google/gemma-4-31b-it:free |
| openrouter | tencent/hy3-preview:free |
| openrouter | poolside/laguna-m.1:free |
| openrouter | inclusionai/ling-2.6-1t:free |
| cohere | command-r-plus-08-2024 |
| cohere | command-a-03-2025 |
| cloudflare | @cf/meta/llama-3.3-70b-instruct-fp8-fast |
| cloudflare | @cf/meta/llama-4-scout-17b-16e-instruct |
| cloudflare | @cf/openai/gpt-oss-120b |
| cloudflare | @cf/zai-org/glm-4.7-flash |
| cloudflare | @cf/qwen/qwen3-30b-a3b-fp8 |
| zhipu | glm-4.5-flash |
| zhipu | glm-4.7-flash |
| github | gpt-4o |
| github | openai/gpt-4.1 |

### 3.2 is_reasoning = 1 (JSON modunda exclude):

| Platform | model_id | Sebep |
|---|---|---|
| cloudflare | @cf/moonshotai/kimi-k2.5 | reasoning trace, content null |
| cloudflare | @cf/moonshotai/kimi-k2.6 | reasoning trace |
| cloudflare | @cf/deepseek-ai/deepseek-r1-distill-qwen-32b | R1 distill |
| mistral | magistral-medium-latest | reasoning |
| openrouter | nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | reasoning |
| openrouter | nvidia/nemotron-3-super-120b-a12b:free | reasoning |
| openrouter | nvidia/nemotron-3-nano-30b-a3b:free | reasoning |
| openrouter | nvidia/nemotron-nano-9b-v2:free | reasoning |
| openrouter | liquid/lfm-2.5-1.2b-thinking:free | thinking |
| openrouter | poolside/laguna-xs.2:free | poolside thinking |
| ollama | kimi-k2-thinking | thinking |
| ollama | cogito-2.1:671b | reasoning |

Not: bazı model `supports_json_mode=1 AND is_reasoning=1` olabilir (örn. bazı
DeepSeek varyantları). `requireJsonMode` modunda `is_reasoning=1` öncelikli
(exclude). Diğer durumlarda is_reasoning sadece bilgi amaçlı.

## 4. Router

`routeRequest(estimatedTokens, skipKeys, preferredModelDbId, requireVision,
requireJsonMode)`:

```sql
SELECT * FROM models
 WHERE id = ?
   AND enabled = 1
   {requireVision   ? AND vision_capable = 1   : ''}
   {requireJsonMode ? AND supports_json_mode = 1 AND is_reasoning = 0 : ''}
```

`No json-mode model enabled` 400 message için ek kontrol (vision'la aynı pattern).

## 5. runChatCompletion

```ts
const requireJsonMode = parsed.response_format
  && (parsed.response_format.type === 'json_object'
   || parsed.response_format.type === 'json_schema');

const preferredModel = resolvePreferredModel(requestedModel, messages,
  requireVision, requireJsonMode);

route = routeRequest(estimatedTotal, skipKeys, preferredModel,
  requireVision, requireJsonMode);
```

`resolvePreferredModel(modelId, messages, requireVision, requireJsonMode)`:
- Pinned model + requireJsonMode=true + supports_json_mode=0 OR is_reasoning=1
  → drop pin (return undefined → auto-route)

## 6. CompletionOptions

`server/src/providers/base.ts`:
```ts
export interface CompletionOptions {
  ...
  response_format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean } };
}
```

## 7. Provider passthrough

### 7.1 openai-compat

Body'e `response_format` ekle (zaten OpenAI'da geçerli alan):
```ts
body: JSON.stringify({
  ...,
  response_format: options?.response_format,
})
```

Groq/SambaNova/Cerebras/OR/Mistral/Zhipu/GitHub `response_format` native
destek (json_object çoğu, json_schema bazıları). Provider 400 ederse cascade
gerçekleşir.

### 7.2 Cloudflare

Cloudflare OpenAI-compat layer'ı `response_format` field'ını forward eder.
`cloudflare.ts` body'sine ekle (cloudflare.ts ayrı dosya).

### 7.3 Google (Gemini)

```ts
const generationConfig: Record<string, unknown> = { ... };
if (options?.response_format?.type === 'json_object') {
  generationConfig.responseMimeType = 'application/json';
} else if (options?.response_format?.type === 'json_schema') {
  generationConfig.responseMimeType = 'application/json';
  generationConfig.responseSchema = options.response_format.json_schema.schema;
}
```

### 7.4 Cohere

v2/chat API'da `response_format` desteği var; cohere.ts'e ekle (mevcutsa
passthrough).

## 8. Tests

| Dosya | Test |
|---|---|
| `lib/schema-response-format.test.ts` | accept text/json_object/json_schema; reject unknown type |
| `services/router-json-mode.test.ts` | requireJsonMode → only supports_json_mode=1; reasoning excluded; no-model-available 400; pin drop |
| `providers/google-json-mode.test.ts` | json_object → responseMimeType set; json_schema → responseSchema set; text → no mime |
| `providers/openai-compat-json-mode.test.ts` | body.response_format forwarded |
| `routes/proxy-json-mode.test.ts` | E2E: json_object request reaches a non-reasoning route |
| `db/migrate-v12.test.ts` | column exists; flag counts |

## 9. Limit edge cases

- `response_format=text` veya yok → routing eskisi gibi (her enabled model)
- `response_format=json_object` + vision payload → hem `supports_json_mode=1`
  hem `vision_capable=1` rows
  (Llama-4-Scout/Maverick, Gemini 2.5/3.x bunların kesişimi)
- Hiç ortak yoksa 400 explicit message

## 10. Rollout

1. Local impl + 30+ test pass
2. `bash scripts/deploy.sh`
3. Smoke: emlak ajanı `TapuOcr` test'i
4. CLAUDE.md + API-KULLANIM.md commit
5. your app notify (zaten kendi tarafında fix var; bizim taraftaki fix
   onu da içerir)

## 11. Faz 2 (sonra)

- `json_schema` strict mode normalize layer (provider farkları)
- Reasoning model'ler için "soft route" — JSON istemiyorsa kullan, isterse skip
- Probe-models cron'unda JSON mode test ekle
