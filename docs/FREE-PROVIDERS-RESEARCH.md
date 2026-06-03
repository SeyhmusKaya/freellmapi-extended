# Free Provider Research — LLM + Image (Mayıs 2026)

> **Politika** (kullanıcı kararı): Tek-kullanımlık veya çok-az-kredi
> ($0.10/ay veya $5-25 lifetime credit) sağlayıcılar **eklenmez**.
> Yalnız: (a) sürdürülebilir free tier (b) recurring monthly quota
> (c) keyless servisler.

Production'da aktif (Mayıs 2026):

### Text / Chat LLM (13 platform)
google, groq, cerebras, sambanova, mistral, openrouter, github, cohere,
cloudflare, zhipu, ollama, **deepseek**, **ai21**, **reka**.

### Image generation (3 platform, 13 model)
cloudflare (5), pollinations (8 keyless), zhipu (3 CogView).

### Audio STT (1 platform, 2 model)
cloudflare (Whisper turbo + Whisper).

---

## A. Politika gereği SKIP edilenler

| Provider | Sebep | Karar |
|---|---|---|
| Together AI | $25 trial-only sonra paid | SKIP |
| Fireworks AI | $1 trial + key creation problemli | SKIP |
| Hugging Face Inference | ~$0.10/ay credit — pratik değil | SKIP (kalıcı) |
| AI21 Jamba | ~~$10 trial~~ kullanıcı anahtarı verdi → eklendi | EKLENDİ |
| Stability AI | 25 credits → ~10 img | SKIP |
| Anyscale, Modal, RunPod | Compute-rent, self-deploy gerek | SKIP |
| Replicate | İlk hafta credit | SKIP |
| OctoAI | Kapandı (NVIDIA aldı) | N/A |
| Anyscale Endpoints | Kapandı | N/A |
| Perplexity | Web only, no API free | SKIP |
| Anthropic / OpenAI | Hepsi paid | SKIP |
| Google Gemini Image | "Free tier 500/gün" iddia → gerçekte billing setup gerekiyor, free limit=0 (May 2026 probe) | SKIP |
| Leonardo.ai API | API erişimi $5 credit zorunluluğu → ödeme bilgisi gerek | SKIP |
| Recraft API | Aynı: API key için $5 credit zorunlu | SKIP |
| FAL.ai | $1 trial credit only | SKIP |
| Ideogram | 10 slow credit/hafta, API ödeme istiyor | SKIP |

---

## B. Production'a eklenmiş (Mayıs 2026)

| Platform | Anahtar tipi | Yetenek | Kapasite |
|---|---|---|---|
| Google Gemini 2.5/3.x | per-account | text + vision + JSON | ~30M/ay |
| Groq | 6 key | text + tools | ~15M/ay × 6 |
| Cerebras | 1 key | text | ~30M/ay |
| SambaNova | 6 key | text + DeepSeek | ~6M/ay × 6 |
| Mistral | 5 key | text + JSON | ~50-100M/ay |
| OpenRouter | 16 key | text + frontier | ~6M/ay × 16 |
| GitHub Models | 2 key | text | ~9-18M/ay |
| Cohere | 2 key | text RAG | ~1-2M/ay × 2 |
| Cloudflare Workers AI | 9 key | text + image + audio | 10K neurons/key/gün |
| Zhipu Z.ai | 2 key | text + CogView image | ~30M/ay × 2 + 200 img/gün |
| Ollama Cloud | per-account | text (heavyweight frontier) | 5h session/gün |
| Pollinations.ai | keysiz | image | ~1500/gün soft |
| **DeepSeek Direct** | 1 key (YENİ) | text V3.2 + R1 | ~5M token (kredi gerekir) |
| **AI21 Studio** | 1 key (YENİ) | text Jamba Mini 2 + Large 1.7 | ~10M token |
| **Reka AI** | 1 key (YENİ) | text Flash 3 + Edge 2603 (vision) | ~10M token |

**V23 düzeltmesi (Mayıs 2026)**: V22'de eklenen `jamba-1.6` serisi AI21
tarafından retire edilmiş; gerçek model_id'ler `jamba-mini-2-2026-01` ve
`jamba-large-1.7-2025-07`. Reka için `reka-core` API'de yok; yerine
`reka-edge-2603` (vision) eklendi. `reka-flash-3` context_window 65536'ya
düzeltildi. DeepSeek `deepseek-chat` + `deepseek-reasoner` doğru ID'lerde
fakat new-account credit otomatik verilmiyor → 402 "Insufficient Balance"
dönüyor, kullanıcı platform.deepseek.com'da credit yüklemeli.

**Toplam aggregate**: ~2B token/ay text + ~1500-2600 image/gün +
~600 minute/gün audio STT.

---

## C. Potansiyel adaylar (henüz eklenmedi, kullanıcı kararı bekliyor)

### Recurring free tier var, anahtar gerekirse araştırılabilir:

| Provider | URL | Yetenek | Free tier şekli |
|---|---|---|---|
| MiniMax Direct | platform.minimaxi.com | text + image + video | 1M token/ay recurring (CN-account gerek) |
| Cohere image | cohere.com | text + Aya Vision | already integrated chat |
| Inferless free | inferless.com | custom deploy | self-deploy, free GPU credit |
| Lepton AI | lepton.ai | text + image | $0 free GPU per ay (small) — politika sınırında |

### Keyless servisler (kayıt YOK):

| Service | Notlar |
|---|---|
| Pollinations.ai | ✅ Mevcut. 8 model |
| `tts.api.cambai.tech` | TTS keysiz (audio-out, scope dışı) |
| `image.openart.ai` | OpenAI-uyumlu fakat unreliable |

### Audio/STT eklemeleri:

| Provider | Notlar |
|---|---|
| Cloudflare Whisper turbo | ✅ Mevcut |
| OpenAI Whisper (cloud) | Paid |
| Groq Whisper | Gizli endpoint, dökümante değil |
| Deepgram | $200 free credit one-time → SKIP |
| AssemblyAI | $50 free credit → SKIP |

### TTS (text-to-speech, gelecek kategori):

- **Cloudflare melotts** (`@cf/myshell-ai/melotts`) — TR/EN destekler
- **ElevenLabs** — 10K karakter/ay free recurring ✓ aday
- **CartesiaAI** — $5 lifetime SKIP
- **Replicate XTTS-v2** — trial SKIP

---

## D. Önerilen sıradaki eklemeler (politika uyumlu, recurring free)

1. **Cloudflare TTS (`@cf/myshell-ai/melotts`)** — yeni TTS endpoint
   `/v1/audio/speech` (OpenAI compat). 0 yeni key. ~2h.
2. **ElevenLabs TTS** — 10K karakter/ay recurring, kullanıcı kayıt isterse.

---

## E. Catalog cleanup (V24 hedefi — dead model_id tespiti)

V23 AI21/Reka düzeltmeleri yapıldı. Sıra: SambaNova `GONE` ve Cerebras 404
gibi production'da error veren model_id'leri DB'den disable etmek.

```bash
ssh root@YOUR_SERVER_IP
sqlite3 /opt/freellmapi/server/data/freeapi.db <<'SQL'
.headers on
.mode column
SELECT platform, model_id, COUNT(*) AS n, substr(error,1,80) AS err
  FROM requests
 WHERE status='error' AND created_at>=datetime('now','-3 days')
   AND (error LIKE '%404%' OR error LIKE '%410%' OR error LIKE '%GONE%')
 GROUP BY platform, model_id, substr(error,1,80)
 ORDER BY n DESC LIMIT 30;
SQL
```

Çıktı V24 migration ile disable edilir.

---

## F. V23-V28 changelog (Mayıs 2026)

### V23 — AI21 / Reka catalog fix
- AI21: `jamba-large-1.6` + `jamba-mini-1.6` disabled (retired);
  `jamba-large-1.7-2025-07` + `jamba-mini-2-2026-01` added.
- Reka: `reka-core` disabled (API'de yok); `reka-edge-2603` (vision) added;
  `reka-flash-3` context_window 65536'ya düzeltildi.
- `classifyError`: "insufficient balance" / "402" → `invalid_key` bucket
  eklendi (1 saat cooldown, DeepSeek 402 cascade gürültüsünü engeller).

### V24 — dead model_id cleanup
- `cerebras/qwen3-235b`, `sambanova/DeepSeek-V3.1-cb`, 3× openrouter
  retired-free models disable edildi (7d error-log analizinden).

### V25 — CF SD img2img deprecate
- CF Workers AI tüm SD modellerinde img2img kaldırdı (probe edildi).
  `supports_img2img=0` set: dreamshaper-8-lcm, sdxl-base-1.0,
  sd-1.5-inpainting. Inpainting (mask ile) + outpainting (server auto-mask)
  hâlâ çalışıyor.
- CF Whisper `audio` field array yerine **base64 string** istiyor (V25 fix).

### V26 — cascade-spam reduce
- OpenRouter `:free` rows priority +100 (sacrificial-lamb pozisyonunundan
  last-resort'a indirildi).
- `SHORT_FALLBACK_MS` (rate_limit_minute cooldown) 60s → 180s.
- `MAX_RETRIES` 20 → 8.

### V27 — Pollinations img2img
- `pollinations/flux` → `supports_img2img=1`. `?image=URL` desteğiyle
  distilled flux i2i. Orta kalite, fallback rolünde.

### V28 — CF FLUX.2 klein 9B (image quality bump)
- Real BFL Flux.2, multipart/form-data API, 4-step ~1-2s latency.
- Unified T2I + i2i, **default tercih img2img için**.
- E2E test: T2I 1.1s 220KB, I2I 2.2s 680KB (Pollinations ~10× quality bump).
- Pollinations chain'de kalıyor (fallback).

### V29-V31 — modality fix + embeddings (May 2026)

**V29**: `requests.modality` INSERT bug fix + backfill. logRequest() INSERT
artık modality kolonu yazıyor (text / image_gen / image_edit / image_inpaint /
audio_stt / embedding). Geçmiş row'lar models katalog modality'sinden
backfill. Analytics image panel'i artık doğru sayıyor (önce 0 gösteriyordu).

**V30**: embedding catalog seed — 12 model, 6 platform, modality='embedding':
- cloudflare BGE-m3 (multilingual default) + large-en/base-en/small-en
- google gemini-embedding-001 (Matryoshka 256/512/768)
- cohere embed-english-v3.0 + embed-multilingual-v3.0 + embed-v4.0 (128K ctx)
- mistral mistral-embed
- zhipu embedding-3 + embedding-2
- github openai/text-embedding-3-large (Azure proxy)

**V31**: `batch_items.endpoint` column. BatchWorker chat vs embedding
dispatch. `/v1/batches` item shape `{url:'/v1/embeddings'|'/v1/chat/completions',custom_id,body}`.
Mixed batches (aynı içinde chat+embedding) çalışır.

`/v1/embeddings` endpoint OpenAI-uyumlu, native array batch, dimensions
Matryoshka cap, cascade router (CF→Google→Cohere→Mistral→Zhipu→GitHub).

### Denenip vazgeçilen (May 2026)
- **Gemini Image (Nano Banana, Nano Banana 2, Nano Banana Pro)**: 4 model
  da 429 "limit: 0" döndü. Google'ın "500/gün free" iddiası billing setup
  şartına bağlı. Politika dışı (credit-card gerek).
- **Leonardo / Recraft / FAL / Ideogram**: API key almak için $1-5 ödeme
  bilgisi zorunlu. Politika dışı.
- **ModelsLab** (May 2026): "100 call/gün free no CC" iddiasını web/blog
  yayınları tekrar ediyor. Probe edildi (zXobV... key): 4 model (flux,
  sdxl, sd3, hidream-o1) hepsi `"Out of credits! Subscribe now or fund
  your wallet"` döndü. Signup-anında credit verilmiyor; wallet $0 ile
  başlıyor → wallet top-up gerek → politika dışı. Key DB'den silindi.
- **Hyperbolic** (May 2026): $1 trial credit one-time, sonra paid →
  trial politikası gereği SKIP.

### V33 — comprehensive provider audit (May 2026)

Tüm aktif provider'ların live `/models` endpoint'lerini probe ederek katalog
ile diff aldık. Bulunan + free-tier doğrulanmış 22 yeni model katalog'a
eklendi (V33 migration). Atlanan ve sebebleri:

**Eklenmiş (V33)**:
- **GitHub Models (+19)**: gpt-4o-mini, gpt-4.1-mini/nano, o1-mini, llama-4-scout-17b,
  llama-3.3-70b, phi-4, phi-4-mini/reasoning, deepseek-r1, deepseek-v3-0324,
  codestral-2501, ministral-3b, mistral-medium-2505, mistral-small-2503,
  llama-3.2-11b/90b-vision, phi-4-multimodal, text-embedding-3-small
- **Cerebras (+1)**: llama3.1-8b
- **Zhipu (+3)**: glm-4.6, glm-4.5, glm-4.5-air
- **Mistral (+4)**: magistral-small (reasoning), ministral-8b/3b, mistral-small-latest
- **OpenRouter (+2)**: llama-3.2-3b:free, hermes-3-llama-3.1-405b:free

**Probed ama paid (SKIP)**:
- GitHub: gpt-5/gpt-5-mini/gpt-5-nano/o4-mini/xai-grok-3-mini → "Unavailable
  model" (Copilot Pro veya paid plan gerek)
- Google: imagen-4.0-*, veo-3.0-*, lyria-3-*, gemini-3-pro-image, gemini-tts-* →
  billing setup zorunlu (önceden Gemini Image probe'da görüldü)
- Mistral: pixtral-large, mistral-large-2512 → paid tier
- DeepSeek: deepseek-v4-flash → bizim hesapta 402 (önceden tespit)

**Bekleyen yeni modaliteler** (provider impl + modality kayıt gerek):
- **Groq Orpheus TTS** (`canopylabs/orpheus-v1-english`, `orpheus-arabic-saudi`) —
  alternative TTS provider, OpenAI-compat audio endpoint
- **Mistral Voxtral STT** (`voxtral-small-latest`, `voxtral-mini-2507`) —
  alternative STT provider
- **Cohere Transcribe** (`cohere-transcribe-03-2026`) — STT
- **Cohere Rerank** (`rerank-v3.5`, `rerank-v4.0-fast/pro`) — yeni modality
  (`rerank` — sıralama, embedding'den farklı use-case)
- **Cohere Vision** (`command-a-vision-07-2025`, `c4ai-aya-vision-32b`) —
  zaten vision_capable işaretlenebilir (impl yok)

Bunlar V34+ olarak ayrı planlanmalı (her biri provider method ekleme +
yeni endpoint veya modality routing).

**Sonuç**: image-gen pool'u **CF FLUX.2 + CF SD + Pollinations + Zhipu**
ile sınırlı. Quality default = CF FLUX.2 klein-9b. Pollinations distilled
kalite için sadece son çare.

### V34 — Rerank (yeni modality)

Cohere `/v2/rerank` entegre edildi. 3 model: `rerank-v3.5` (multilingual
TR ✓), `rerank-v4.0-fast`, `rerank-v4.0-pro`. Endpoint `POST /v1/rerank`.
RAG pipeline fine-tuning use-case: embedding ile 100 aday → rerank ile
top-K. Cohere free trial: 1000 call/ay/key. E2E prod test ile TR query
doğru sıralama döndü.

### V35 — NVIDIA NIM + key expiry tracking

**NVIDIA NIM** key (seho-nvidia, 40 RPM, 6-ay expiry) eklendi. Live probe:
123 model. V35 ile 11 model eklendi (chat 6 + vision 3 + embed 2; biri
account'a 404 döndü, disabled).

**V35a — `api_keys.expires_at` column**: NVIDIA 6-ay TOS için. Health
checker `<30 gün warn`, `<7 gün error` log'lar. KeysPage UI badge.

**V35b — NVIDIA embed `input_type` fix**: NVIDIA NIM embed modelleri
`input_type: 'query'|'passage'` + `truncate: 'NONE'` zorunlu kılıyor.
`OpenAICompatProvider.embed` platform-specific branch eklendi.

### V36 — NVIDIA expansion (+15 model)

Frontier chat (qwen3-coder-480b, minimax-m2.7, kimi-k2.6, glm-5.1,
gpt-oss-120b, nemotron-3-super-120b), specialty (palmyra-med/fin/creative),
code (codellama-70b, deepseek-coder-6.7b), embed (nv-embedqa-mistral-7b-v2,
bge-m3, arctic-embed-l, nv-embedcode-7b-v1, nv-embed-v1).

NVIDIA'da YOK: image-gen, real audio (TTS/STT), rerank → CF / Pollinations
/ Cohere'da kalıyor.

### V32a — Smart cooldown logic (May 2026, post-V36 patch)

Audit: 2 günlük prod error log'unda DeepSeek "Insufficient Balance" 86×
sonsuza retry; OR `:free` "Provider returned error" 196× yetersiz classify.

Fixler:
- `classifyError` genişletildi: "insufficient balance" / "out of credits" /
  "exceeded your current quota" / "402" → **`rate_limit_day`** (24h kilit).
  Eski "402 → invalid_key (1h)" hatalı idi (wallet drained, retry boş).
  "provider returned error" → **`rate_limit_minute`**.
- **`setKeyCooldown(platform, keyId, reason)`** — yeni key-wide lock.
  `model_id='*'` wildcard kayıt. `isOnCooldown` her iki kayıdı (model-specific
  + wildcard) kontrol eder.
- 7 dispatch lib (chat/embed/image-gen/image-edit/audio-stt/audio-tts/
  rerank) catch-block güncellendi: `invalid_key` veya `rate_limit_day`
  → key-wide lockout (tüm modeller); minute/unknown → model-specific.

Etki: DeepSeek 86 spam → 0 (key 24h locked), OR :free cascade noise düştü.

### V57 — balanced health-aware routing (Haz 2026)

Audit: prod 7g `requests` = 18800 istek, **%67.8 başarı**, 36s ort latency.
Per-platform: nvidia trafiğin %71.9'u (13701 istek, %74, 36s); openrouter %7;
cerebras %20. En sık hata **"This operation was aborted" 3067×** (timeout),
sonra "404 Not Found" 837× (ölü cerebras/OR model). 91 enabled text modelin
tamamına localhost stres testi (`stress_test.py`, no_cascade pin, hız+kalite)
+ flap doğrulama (`confirm2.py`, 8 çağrı) yapıldı.

Kök neden: V38 skoru `intelligence_rank×6` → yavaş frontier (480B p1, 33s,
%51) ve ÖLÜ modeller (`minimax-m2.5:free` ir=1 → p3, %0/849, "no endpoints")
zincirin tepesinde. Hızlı+güvenilir 70B-class (groq/sambanova/cohere/mistral,
<0.5s, %100 idle) dipte.

Fixler:
- **qualityRank rebalance**: intelligence ×6→×1.0 (rank 12 cap) + speed ×0.5.
  ÜSTÜNE ölçülen `healthPenalty` (0..75, requests 7g success%, n≥8) +
  `latencyPenalty` (0..40, avg success latency) + `UNTESTED_PENALTY` (+10,
  trafik yoksa unproven model lider olamasın). `applyQualityOrder` requests
  tablosunu okur, her boot çalışır.
- **`model_gone`** cooldown sınıfı: 404 / "no endpoints found" /
  decommissioned → 6h (5dk unknown ile sonsuz re-404 yerine). runChatCompletion
  + streaming bunu tüm-model skip olarak ele alır.
- **cascade-on-400**: `isBadRequestError` (400/422) artık fatal değil — modeli
  atla, cascade devam. NVIDIA phi-4-multimodal json_object'te 400 dönüp tüm
  cascade'i batırıyordu (sink). Ayrıca `supports_json_mode=0` set edildi.

Doğrulama (canlı, `load_test.py`): auto-route burst conc=25, 300 istek
→ sink fix öncesi %74.3, sonrası **%100**, p50 0.9s, ilk-deneme %88, yük
groq/CF/nvidia'ya dağıldı (eski tek-model monokültür gitti). **Model disable
EDİLMEDİ** — flap edenler (OR :free, cerebras free) ölçülen sağlıkla demote,
kapasite olarak kaldı. Karar gerekçesi: "boştayken çalışıyorsa kapatma".

### Mevcut modalite + provider matrix (V36 sonrası)

| Modality | Providers | Total enabled |
|---|---|---|
| Chat (text) | google, groq, cerebras, sambanova, nvidia, mistral, openrouter, github, cohere, cloudflare, zhipu, ollama, deepseek, ai21, reka | ~115 |
| Image-gen | cloudflare (FLUX.2 klein-9b default), pollinations, zhipu CogView | ~17 |
| Audio STT | cloudflare Whisper-large-v3-turbo / Whisper | 2 |
| Audio TTS | cloudflare MeloTTS (en/es/fr/zh/ja/ko, TR YOK) | 1 |
| Embeddings | cloudflare (BGE), google, cohere, mistral, zhipu, github, **nvidia** | ~17 |
| Rerank | cohere (v3.5 multilingual, v4.0-fast/pro) | 3 |

**Toplam**: ~155 enabled model, 15 provider, 6 modality.
