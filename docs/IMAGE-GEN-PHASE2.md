# MyLLM Image Generation Faz 2

Hedef: Cloudflare yanına 2. keyless provider (Pollinations.ai) ekleyerek
imageGen kapasitesini büyütmek + provider mimarisinde "keyless" konsepti
açmak (sonraki Zhipu CogView için zemin).

> Pattern: aynı modality='image_gen' filter, aynı cascade. Yeni iş = keyless
> provider mimarisi + 4 Pollinations row seed.

---

## 0. Neden Pollinations?

- Anahtarsız, hemen kullanılabilir
- IP başına ~5 req/dk soft limit (cascade içinde sorun yok)
- 4+ model: flux, turbo, flux-realism, flux-anime, flux-3d, midjourney
- Free tier ToS issue YOK — açıkça ücretsiz
- Cloudflare Neuron havuzunu boşa kullanmıyor (CF'ye dokunmadan ekstra
  ~500-1500 resim/gün kapasite)

---

## 1. API kullanımı

```
GET https://image.pollinations.ai/prompt/{encoded_prompt}?width=W&height=H&seed=S&model=M&nologo=true&private=true
```

- Query string parametreleri: `width`, `height`, `seed`, `model`, `nologo`,
  `private`, `negative_prompt` (bazı modellerde).
- Yanıt: binary JPEG (varsayılan) veya PNG (?format=png).
- Auth yok. Rate limit IP/dakika.
- Public URL, prompt URL-encoded → bizim provider encode eder.

### Modeller (Mayıs 2026)
| Pollinations model_id | Hız | Kalite | Notlar |
|---|---|---|---|
| `flux` | orta | yüksek | Genel amaçlı, default |
| `turbo` | en hızlı | iyi | LCM tabanlı, hızlı |
| `flux-realism` | yavaş | foto-gerçekçi | Portre/sahne |
| `flux-anime` | yavaş | anime | Karakter |

---

## 2. Keyless provider mimarisi

### 2.1 BaseProvider

```ts
export abstract class BaseProvider {
  readonly requiresApiKey: boolean = true;   // default
  // ...
}
```

Pollinations provider'ı `requiresApiKey = false` set eder.

### 2.2 Router uyumluluğu

`api_keys` tablosunda Pollinations için row YOK. Router yine bu provider'ı
kullanabilmeli. Çözüm: keys sorgusu sonrası `provider.requiresApiKey` false
ise sentetik tek key satırı oluştur (id=0, apiKey='').

```ts
let keys = db.prepare('...').all(...);
if (keys.length === 0 && !provider.requiresApiKey) {
  keys = [{ id: 0, platform: model.platform, encrypted_key: '', iv: '',
            auth_tag: '', status: 'healthy', enabled: 1 }];
}
```

`decrypt()` çağrısı sadece `key.id > 0` iken yapılır:
```ts
const decryptedKey = key.id === 0 ? '' : decrypt(...);
```

### 2.3 Health checker

`api_keys` tablosunu okuduğu için Pollinations için key validate yapmaz —
sorun yok, sentetik key DB'de yok.

### 2.4 Usage counters

`usage_counters` schema platform+model_id+key_id keylenir. key_id=0 olarak
yazılır; aynı satır gün boyu artar (tek "key" var). RPD yok ama TPM/TPD
nominal — Pollinations rate-limit zaten gevşek.

---

## 3. DB migration V16

```ts
function migrateModelsV16Pollinations(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO models (
    platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
    rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
    enabled, modality, neurons_per_call
  ) VALUES (?, ?, ?, ?, ?, 'Image', ?, null, null, null, '~unlimited', null, 1, 'image_gen', null)`);
  const rows = [
    ['pollinations', 'pollinations/flux',         'FLUX (Pollinations, keyless)',       1, 3, 5],
    ['pollinations', 'pollinations/turbo',        'Turbo (Pollinations, keyless)',      3, 1, 5],
    ['pollinations', 'pollinations/flux-realism', 'FLUX Realism (Pollinations)',        2, 6, 5],
    ['pollinations', 'pollinations/flux-anime',   'FLUX Anime (Pollinations)',          4, 6, 5],
  ];
  // rpm_limit=5 to respect soft rate; rpd=null infinite
  // priority = sırasıyla 50-53 (CF rows önce gelsin tercihen)
}
```

Auto-route'ta CF flux-1-schnell prio 1, sonra CF lightning, CF dreamshaper,
sonra Pollinations. Pollinations yavaş ama kotasız → cascade'in son durak'ı.

---

## 4. Provider

`server/src/providers/pollinations.ts`:

```ts
export class PollinationsProvider extends BaseProvider {
  readonly platform = 'pollinations' as const;
  readonly name = 'Pollinations.ai';
  readonly requiresApiKey = false;

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw new Error('Pollinations.ai does not support chat completion');
  }
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw new Error('Pollinations.ai does not support streaming');
  }
  async validateKey(): Promise<boolean> { return true; }

  async generateImage(_apiKey, modelId, prompt, options) {
    const [w, h] = (options?.size ?? '1024x1024').split('x').map(Number);
    const baseModel = modelId.replace(/^pollinations\//, '');
    const n = Math.max(1, Math.min(options?.n ?? 1, 4));

    const callOnce = async (idx: number) => {
      const params = new URLSearchParams({
        width: String(w),
        height: String(h),
        model: baseModel,
        nologo: 'true',
        private: 'true',
      });
      if (options?.seed != null) params.set('seed', String(options.seed + idx));
      if (options?.negative_prompt) params.set('negative_prompt', options.negative_prompt);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
      const res = await this.fetchWithTimeout(url, { method: 'GET' }, 60_000);
      if (!res.ok) throw new Error(`Pollinations error ${res.status}: ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    };

    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await callOnce(i));
    return { b64Images: out, mimeType: 'image/jpeg' };
  }
}
```

Register in `providers/index.ts`.

---

## 5. Tests

| Dosya | Test |
|---|---|
| `providers/pollinations.test.ts` | 1) generateImage builds correct URL with prompt+model+w/h 2) seed offset for n>1 3) chat throws 4) requiresApiKey=false |
| `services/router-keyless.test.ts` | 1) routeRequest finds Pollinations w/o api_keys row 2) keys.length=0 fallback to synthetic key for keyless provider only |
| `db/migrate-v16-pollinations.test.ts` | rows seeded, modality=image_gen |
| `routes/images-pollinations.test.ts` | E2E POST with pin model='flux' (Pollinations) → routes pollinations |

---

## 6. Limitler

- Pollinations soft rate ~5 req/dk/IP. Server level → cascade içinde mevcut.
- n>1: serial calls.
- Response binary JPEG. PNG istenirse Faz 3.
- Negative prompt sadece bazı modellerde geçerli — Pollinations ignore ederse sessizce devam.

---

## 7. Rollout

1. Local impl + tests
2. Deploy
3. Smoke: `curl ... -d '{"prompt":"a cat","model":"pollinations/flux"}'`
4. CLAUDE.md + API-KULLANIM.md güncel
5. Faz 3: Zhipu CogView (anahtar gelirse) + response_format=url storage

---

## 8. Kapasite tahmini (toplam)

| Source | Resim/gün |
|---|---|
| Cloudflare (mevcut) | ~500-1100 |
| Pollinations (yeni) | ~500-1500 (IP throttle) |
| **TOPLAM** | **~1000-2600/gün** |

Zhipu CogView eklenirse +200.
