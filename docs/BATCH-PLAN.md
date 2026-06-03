# MyLLM Batch API — Detaylı Faz Planı

Hedef: MyLLM'i sync proxy'den **multi-tenant async batch processing**'i
destekleyen bir platforma çıkarmak. OpenAI Batch API stil + sade /v1/batches
endpoint'i. your app + diğer kendi projelerin + arkadaşının projeleri ortak
unified key ile aynı batch arka ucunu kullanır.

> Bu dosya implementasyondan ÖNCE yazıldı. Tüm faz/dosya/kod bölümleri
> uygulanacak işin spec'idir; kod henüz yazılmadı.

---

## 0. Genel İlkeler

- **OpenAI-uyumluluk**: endpoint adı `/v1/batches`, alan adları OpenAI'ya
  yakın (`custom_id`, `body`, `status`, `request_counts`).
- **Mevcut routing'i tekrar kullan**: her batch item, mevcut sync
  `/v1/chat/completions` akışından geçer → auto-route + fallback cascade +
  cooldown + rate-limit servisi otomatik geçerli. Tekrar yazma yok.
- **Restart-safe**: pending item'lar DB'de; pm2 restart sonrası worker
  kaldığı yerden devam.
- **Provider RPM doğal saygı**: ekstra hız hilesi yok. Batch sadece
  ASENKRON + DAYANIKLI biriktirme katmanı.
- **Single instance worker**: tek pm2 process'te tek worker (myllm). Çok
  instance gelirse advisory lock eklenir; şimdilik gerek yok.
- **Auth aynı**: Bearer `myllm-...` unified key. Multi-user için per-key
  namespace ileride (faz 5).
- **Privacy**: request/response gövdeleri DB'de plaintext (ENCRYPTION_KEY
  ile şifreleme opsiyonel, faz 5). Hassas içerik için consumer kendi
  ucunda mask'lasın.

---

## 1. API Spec

### 1.1 Endpoint listesi

| Method | Path | Açıklama |
|---|---|---|
| POST   | `/v1/batches`              | Batch oluştur |
| GET    | `/v1/batches`              | Batch'leri listele |
| GET    | `/v1/batches/:id`          | Tek batch durumu |
| GET    | `/v1/batches/:id/results`  | JSONL sonuç akışı |
| DELETE | `/v1/batches/:id`          | Pending olanları iptal |

Tümü unified Bearer key ile çağrılır. `/api/batches/...` admin endpoint'i
(dashboard için) ayrı, Basic Auth altında.

### 1.2 POST /v1/batches — istek

```json
{
  "items": [
    {
      "custom_id": "row-1",
      "body": {
        "messages": [{"role":"user","content":"Translate: house"}],
        "model": "llama-3.3-70b-versatile",
        "max_tokens": 40,
        "temperature": 0.2,
        "stream": false
      }
    },
    { "custom_id": "row-2", "body": { ... } }
  ],
  "metadata": { "source": "example-nightly-translate", "tag": "2026-05-20" },
  "callback_url": "https://example.com/webhooks/myllm-batch",
  "priority": "normal"
}
```

- `items` (zorunlu): 1..1000 öğe. `custom_id` zorunlu, batch içinde
  unique. `body` her zaman OpenAI chat completions formatı (model
  opsiyonel = auto-route).
- `metadata` (opsiyonel): JSON, ≤2KB. Pure passthrough.
- `callback_url` (opsiyonel): batch tamamlanınca POST atılacak URL.
  3 deneme, exponential backoff (5s, 30s, 300s).
- `priority` (opsiyonel, varsayılan `normal`): `low|normal|high`. Worker
  high → normal → low sırasıyla picks. Faz 2'de devreye girer.
- Streaming **DESTEKLENMEZ** içeride (sadece sync sonuç). Eğer
  `body.stream:true` gelirse silinir, sync olarak işlenir.

**Header:**
- `Authorization: Bearer <UNIFIED_KEY>` zorunlu
- `Idempotency-Key: <opaque>` opsiyonel — aynı key 24s içinde aynı
  batch_id döner (faz 4)

**Yanıt 201 Created:**
```json
{
  "id": "batch_01HZK9P0YQ8Q4T7K3R5N9XB2M0",
  "object": "batch",
  "status": "queued",
  "request_counts": { "total": 50, "completed": 0, "failed": 0 },
  "created_at": "2026-05-20T19:15:00Z",
  "metadata": { ... },
  "callback_url": "..."
}
```

**Hatalar:**
- 400 `{"error":{"message":"items array required","type":"invalid_request"}}`
- 400 `items_too_large` (>1000), `payload_too_large` (>5MB),
  `duplicate_custom_id`
- 401 missing/invalid key
- 409 `idempotency_key_conflict` (aynı key farklı body)
- 429 `too_many_active_batches` (>10 aktif batch / unified key)

### 1.3 GET /v1/batches/:id — durum

```json
{
  "id": "batch_01HZK...",
  "object": "batch",
  "status": "processing",        // queued | processing | completed | failed | cancelled
  "request_counts": { "total": 50, "completed": 32, "failed": 1 },
  "created_at": "2026-05-20T19:15:00Z",
  "started_at": "2026-05-20T19:15:01Z",
  "finished_at": null,
  "metadata": { ... },
  "errors": []
}
```

`status` semantiği:
- `queued`: hiç item işlenmedi
- `processing`: en az 1 item done/error, kalan pending var
- `completed`: tüm item'lar done veya error (terminal)
- `failed`: kritik hata, tüm batch durdu (örn. corruption); nadir
- `cancelled`: kullanıcı DELETE ile iptal etti, pending item'lar atlandı

### 1.4 GET /v1/batches/:id/results — JSONL akışı

Content-Type: `application/x-ndjson`. Her satır:

```json
{"custom_id":"row-1","status":"done","response":{"id":"chatcmpl-...","choices":[...],"usage":{...},"_routed_via":{"platform":"groq","model":"llama-3.3-70b-versatile"}},"latency_ms":156}
{"custom_id":"row-2","status":"error","error":{"message":"All providers rate-limited","type":"rate_limit"},"latency_ms":62000}
```

- Batch terminal değilse o ana kadar biten itemları döner (partial OK).
- `?since=<position>` query opsiyonel: belirli sıradan sonrasını verir
  (incremental polling).
- Büyük batch için chunked streaming.

### 1.5 DELETE /v1/batches/:id — iptal

- 200: `{"id":"...","status":"cancelled","cancelled_pending":N}`
- 409 `already_terminal` (completed/failed/cancelled)
- Pending item'lar `status='cancelled'`, in-flight olanlar bitene kadar
  bekler (mid-call kesme yok).

### 1.6 GET /v1/batches — liste

Query: `?status=queued&since=<iso>&limit=50&cursor=<id>`. Yanıt:
```json
{ "data": [ {id, status, request_counts, created_at}, ... ], "next_cursor": "..." }
```

---

## 2. Veri Modeli

### 2.1 Şema (better-sqlite3)

```sql
CREATE TABLE batches (
  id              TEXT PRIMARY KEY,           -- "batch_" + ULID
  status          TEXT NOT NULL,              -- queued|processing|completed|failed|cancelled
  total           INTEGER NOT NULL,
  completed       INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 2, -- 1=low 2=normal 3=high
  metadata        TEXT,                       -- JSON, NULL allowed
  callback_url    TEXT,
  callback_status TEXT,                       -- NULL|pending|sent|failed
  callback_attempts INTEGER DEFAULT 0,
  idempotency_key TEXT,                       -- opsiyonel
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX idx_batches_status ON batches(status, priority DESC, created_at);
CREATE UNIQUE INDEX idx_batches_idem ON batches(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE batch_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,           -- batch içindeki sıra
  custom_id       TEXT NOT NULL,
  request_body    TEXT NOT NULL,              -- JSON
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|inflight|done|error|cancelled
  response_body   TEXT,                       -- JSON, done ise dolu
  error_message   TEXT,
  routed_platform TEXT,
  routed_model    TEXT,
  latency_ms      INTEGER,
  attempt         INTEGER NOT NULL DEFAULT 0,
  processed_at    TEXT
);
CREATE INDEX idx_items_pending ON batch_items(batch_id, status);
CREATE INDEX idx_items_global_pending ON batch_items(status, batch_id);
CREATE UNIQUE INDEX idx_items_batch_custom ON batch_items(batch_id, custom_id);
```

### 2.2 ID üretimi
- batch_id = `"batch_" + ULID()` (26 char, ULID node lib veya inline impl).

### 2.3 Migration
`server/src/db/index.ts` içine `migrateBatches()` fonksiyonu eklenir;
`CREATE TABLE IF NOT EXISTS` ile idempotent, mevcut DB'yi bozmaz.

---

## 3. Worker Tasarımı

### 3.1 Sınıf yapısı

`server/src/services/batchWorker.ts`:

```ts
class BatchWorker {
  private running = false;
  private concurrency: number;   // env: MYLLM_BATCH_CONCURRENCY, default 4
  private inflight = new Set<number>(); // batch_items.id seti

  start() { this.running = true; this.loop(); }
  stop()  { this.running = false; }

  private async loop() {
    while (this.running) {
      // Sweep cancelled-pending olarak işaretleme
      this.markCancelledPending();
      if (this.inflight.size >= this.concurrency) {
        await sleep(100);
        continue;
      }
      const item = this.pickNextItem();
      if (!item) { await sleep(500); continue; }
      this.processItem(item).catch(console.error);
    }
  }

  private pickNextItem() {
    // priority DESC, created_at ASC, batch_items.position ASC
    // status='pending' (or 'inflight' on resume after crash)
    // SQL: stale 'inflight' (>10dk processed_at güncellenmedi) → tekrar al
  }

  private async processItem(item) {
    this.inflight.add(item.id);
    db.run("UPDATE batch_items SET status='inflight', attempt=attempt+1 ...");
    db.run("UPDATE batches SET status='processing', started_at=COALESCE(started_at, datetime('now')) WHERE id=?");
    try {
      const t0 = Date.now();
      const body = JSON.parse(item.request_body);
      body.stream = false;
      // ↓↓↓ MEVCUT proxy işleyici çağrısı — aynı kod yolu (router, cascade, cooldown)
      const result = await runChatCompletionInternal(body); // çıkartılacak yardımcı, aşağıda
      const dt = Date.now() - t0;
      db.run("UPDATE batch_items SET status='done', response_body=?, routed_platform=?, routed_model=?, latency_ms=?, processed_at=datetime('now') WHERE id=?", ...);
      bumpBatchCounters(item.batch_id, +1, 0);
    } catch (e) {
      db.run("UPDATE batch_items SET status='error', error_message=?, latency_ms=?, processed_at=datetime('now') WHERE id=?", ...);
      bumpBatchCounters(item.batch_id, 0, +1);
    } finally {
      this.inflight.delete(item.id);
      maybeFinalizeBatch(item.batch_id);
    }
  }
}
```

### 3.2 `runChatCompletionInternal`

`server/src/routes/proxy.ts` içindeki çekirdek routing+cascade mantığı
mevcut `proxyRouter.post('/chat/completions', ...)` handler'ından
ayıklanır → ayrı bir export edilebilir fonksiyon:

```ts
export async function runChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResult> { ... }
```

Hem sync endpoint hem batch worker bunu çağırır. **Tek routing kaynağı.**
A+B+C fallback fix'leri otomatik geçerli.

### 3.3 Concurrency stratejisi

- Default 4. Tüm provider'lar paralel sorulur (router zaten farklı
  key/provider'a dağıtır).
- Tek provider'da yığılma → router cooldown set'i otomatik diğerine.
- 4 yeterli; daha yüksek değer free tier limitlerini hızlı tüketir.

### 3.4 Batch finalizasyon

`maybeFinalizeBatch(batchId)`:
```sql
SELECT total, completed + failed AS done FROM batches WHERE id=?
```
Eğer `done >= total`:
```sql
UPDATE batches SET status='completed', finished_at=datetime('now') WHERE id=?
```
Sonra (callback_url varsa) callback queue'ya ekle.

### 3.5 Crash recovery

- Server boot'ta:
  ```sql
  UPDATE batch_items SET status='pending', attempt=attempt
    WHERE status='inflight';
  ```
  In-flight idi → restart oldu → tekrar pending. Çift işleme idempotent
  değil; ama `attempt` sayacı sayesinde gözlenebilir.

### 3.6 Retry policy (faz 2)

- Item başarısız (retryable provider error: timeout, network) → attempt
  <3 ise tekrar pending'e atılır (cooldown sonrası).
- Non-retryable (400 invalid body, vb.) → direkt error.

---

## 4. Cancellation

- `DELETE /v1/batches/:id`:
  ```sql
  UPDATE batches SET status='cancelled', finished_at=datetime('now')
    WHERE id=? AND status IN ('queued','processing');
  UPDATE batch_items SET status='cancelled'
    WHERE batch_id=? AND status='pending';
  ```
- `inflight` item'lar bitene kadar koşar (cancel mid-call yok). Bitince
  done/error olarak kayda geçer ama batch.status='cancelled' olduğu için
  finalizasyon counter güncellemez.

---

## 5. Webhook (Faz 4)

- `callback_url` set ise batch `completed|cancelled` olunca POST:
  ```json
  {
    "id":"batch_...","status":"completed",
    "request_counts":{"total":50,"completed":48,"failed":2},
    "finished_at":"...","metadata":{...},
    "results_url":"https://myapi.example.com/v1/batches/<id>/results"
  }
  ```
- HMAC imzası header: `X-MyLLM-Signature: sha256=<hex>` — secret = unified
  key (consumer kendi tarafında doğrular).
- Attempt 1 anında. Fail → 5s, 30s, 300s. 3 deneme sonrası
  `callback_status='failed'`.

---

## 6. Idempotency-Key (Faz 4)

- Header `Idempotency-Key: <opaque>` 24s window.
- SQL: `INSERT INTO batches (..., idempotency_key) VALUES(...)` — UNIQUE
  index ihlali → mevcut batch'i döndür.
- Body hash karşılaştırması: kayıtlı body hash'i farklıysa 409
  `idempotency_key_conflict`.

---

## 7. Retention / Cleanup

- Cron (zaten var) günde 1: `DELETE FROM batches WHERE finished_at <
  datetime('now','-7 days')`. CASCADE batch_items'ı temizler.
- Aktif batch (queued/processing) silinmez.
- Konfigüre edilebilir: `MYLLM_BATCH_RETENTION_DAYS=7`.

---

## 8. Limitler / Güvenlik

| Limit | Değer | Override env |
|---|---|---|
| max items / batch | 1000 | `MYLLM_BATCH_MAX_ITEMS` |
| max payload | 5 MB | `MYLLM_BATCH_MAX_BYTES` |
| max active batches / key | 10 | `MYLLM_BATCH_MAX_ACTIVE` |
| concurrency | 4 | `MYLLM_BATCH_CONCURRENCY` |
| retention | 7 gün | `MYLLM_BATCH_RETENTION_DAYS` |
| callback attempts | 3 | `MYLLM_BATCH_CALLBACK_ATTEMPTS` |
| max custom_id length | 256 char | — |

Anti-abuse:
- Per-key aktif batch sayısı limiti
- Per-key günlük toplam item sayısı (faz 5, per-user gelince)
- Payload size kontrolü, items array bytes ≤5MB

---

## 9. Dashboard "Batches" sekmesi (Faz 3)

`client/src/pages/BatchesPage.tsx`:
- Tablo: id (kısa), status (badge), total/completed/failed, created_at,
  source (metadata.source veya tag), elapsed
- Filtre: status, since-date, search by metadata.tag
- Detail drawer: progress bar, son 50 item özet (custom_id/status/latency/routed_via),
  "Download JSONL", "Cancel"
- "New batch" — JSONL upload paste (geliştirici test için)
- Polling 5s (active batch varsa); event-driven istenirse SSE faz 5

App.tsx NavItem ekle: `Batches`.

---

## 10. Dosya Listesi & Tahmini LOC

| Dosya | Yeni/Edit | LOC |
|---|---|---|
| `server/src/db/index.ts` | edit (migration) | +40 |
| `server/src/routes/batches.ts` | YENİ (CRUD endpoint'leri) | ~250 |
| `server/src/services/batchWorker.ts` | YENİ (loop+process) | ~180 |
| `server/src/lib/runChatCompletion.ts` | YENİ (proxy core ayıklaması) | ~120 |
| `server/src/routes/proxy.ts` | edit (yardımcıyı çağır) | -50/+10 |
| `server/src/app.ts` | edit (router register + worker.start) | +6 |
| `server/src/lib/ulid.ts` | YENİ (small ULID) | ~25 |
| `server/src/__tests__/batches.test.ts` | YENİ (vitest) | ~150 |
| `client/src/pages/BatchesPage.tsx` | YENİ | ~280 |
| `client/src/App.tsx` | edit (route + nav) | +4 |
| `docs/BATCH-API.md` | YENİ (consumer doc, API-KULLANIM tarzı) | ~200 |
| `CLAUDE.md` | edit (batch bölümü) | +40 |
| `README.md` | edit (özellik listesi) | +6 |

**Toplam ~1300 LOC** (test + docs dahil), saf kod ~750 LOC.

---

## 11. Faz Listesi

### Faz 1 — MVP (3-4 saat)
- DB migration (batches, batch_items)
- POST/GET single/GET list/DELETE endpoint'leri
- `runChatCompletion` ayıklaması (sync proxy + batch ortak)
- BatchWorker: concurrency 1, FIFO, restart-safe
- GET /v1/batches/:id/results (JSONL, terminal veya partial)
- Sade vitest

Çıktı: your app + arkadaş gece toplu işlemleri çalıştırabilir.

### Faz 2 — Concurrency + iptal (1-2 saat)
- Worker concurrency 4 (env override)
- Stale-inflight reset (crash recovery)
- DELETE iptal yolu + partial results
- Item-level retry (3 deneme, retryable hatalar)

### Faz 3 — Dashboard "Batches" (2-3 saat)
- `BatchesPage.tsx`: liste + detail drawer + JSONL download
- Cancel butonu, polling 5s
- App.tsx nav entry

### Faz 4 — Webhook + Idempotency + Retention (1-2 saat)
- `callback_url` POST + HMAC + 3-attempt backoff
- `Idempotency-Key` header
- Auto-cleanup cron (7 gün)

### Faz 5 — İleri (opsiyonel)
- Per-key namespace (multi-user) — birden çok unified key, batch
  ownership, kota
- Result archival (büyük batch'leri S3'e)
- SSE event stream `/v1/batches/:id/events`
- Response body şifreleme (ENCRYPTION_KEY)
- Priority kuyruğu testi

---

## 12. Konsümer dökümanı (Faz 1 sonu yayınlanacak)

`docs/BATCH-API.md` — `API-KULLANIM.md` tarzı, placeholder key'ler, code
örnekleri (Python OpenAI SDK, curl, PHP). Arkadaşa paylaşılacak.

Örnek Python:
```python
import requests, json, time
KEY="<UNIFIED_KEY>"
BASE="https://myapi.example.com"
items=[{"custom_id":f"r{i}","body":{"messages":[{"role":"user","content":f"Translate to Turkish: {w}"}],"max_tokens":40}} for i,w in enumerate(words)]
r=requests.post(f"{BASE}/v1/batches",json={"items":items,"metadata":{"tag":"nightly"}},headers={"Authorization":f"Bearer {KEY}"})
bid=r.json()["id"]
while True:
    s=requests.get(f"{BASE}/v1/batches/{bid}",headers={"Authorization":f"Bearer {KEY}"}).json()
    if s["status"] in ("completed","failed","cancelled"): break
    time.sleep(5)
for line in requests.get(f"{BASE}/v1/batches/{bid}/results",headers={"Authorization":f"Bearer {KEY}"},stream=True).iter_lines():
    print(json.loads(line))
```

---

## 13. Rollout

1. Branch: `feat/batch-api`
2. Faz 1 implement + lokal test
3. `bash scripts/deploy.sh` → sunucu güncelle
4. Smoke test: 5 itemlık batch (translate) — durum + sonuç
5. your app ajanına notify: `POST /v1/batches` consumer doc + örnek
6. 1-2 gün gözlem (probe log + analytics + DB row sayısı)
7. Faz 2 → deploy → faz 3 → faz 4 sırayla
8. Her faz sonu README + CLAUDE.md güncelle, commit + push

---

## 14. Test Planı

- Birim: ULID, runChatCompletion contract, worker pickNextItem,
  finalize math
- Entegrasyon: 50-itemlık batch — yarısı 200, biri zorunlu hata → counts
  doğru, sonuçlar JSONL doğru
- Failure: server kill mid-batch → restart → kalan item'lar bitince
  batch completed
- Cancel: 100 item batch → 20. itemda DELETE → cancel + partial results
- Idempotency: aynı key 2 kez POST → aynı id
- Webhook: callback_url + sahte test sunucu → POST geldi mi, HMAC doğru mu

---

## 15. Kapanış

Bu plan tam spec — kod yazımı bu doc'un teknik referansıyla doğrudan
ilerleyebilir. Compact sonrası "Faz 1 başla" / "tüm fazları yap"
talimatın ile başlanır. Her faz sonunda commit + push + bu doc'un ilgili
faz bölümü "✅ tamamlandı" işaretlenir.
