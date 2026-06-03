# MyLLM Batch API — Consumer Guide

OpenAI Batch API tarzı async toplu çağrı. Bir paketle 1..1000 chat-completions
isteğini kuyruğa al, MyLLM arka planda işlesin, sonuçları NDJSON akışıyla geri al.

> Auth aynı `Authorization: Bearer <UNIFIED_API_KEY>`. `model` alanı her item'da
> opsiyonel — boş bırakırsan auto-route + fallback cascade devreye girer (sync
> proxy'deki gibi).

---

## Endpoint özet

| Method | Path | Açıklama |
|---|---|---|
| `POST`   | `/v1/batches`              | Batch oluştur |
| `GET`    | `/v1/batches`              | Batch listele |
| `GET`    | `/v1/batches/:id`          | Tek batch durumu |
| `GET`    | `/v1/batches/:id/results`  | NDJSON sonuç akışı |
| `DELETE` | `/v1/batches/:id`          | Iptal (pending itemlar) |

Base URL: `https://myapi.example.com`.

---

## 1. POST /v1/batches

İstek body:

```json
{
  "items": [
    {
      "custom_id": "row-1",
      "body": {
        "messages": [{"role":"user","content":"Translate: house"}],
        "max_tokens": 40,
        "temperature": 0.2
      }
    }
  ],
  "metadata": {"source":"nightly","tag":"2026-05-20"},
  "callback_url": "https://example.com/webhooks/batch",
  "priority": "normal"
}
```

- `items` (zorunlu, 1..1000): her item `custom_id` (batch içinde unique,
  ≤256 char) + `body` (OpenAI chat-completions formatı). `body.stream` true
  gelirse silinir, hep sync çalışır.
- `metadata` (opsiyonel, ≤2KB JSON): passthrough.
- `callback_url` (opsiyonel): batch finalize olunca POST atılır.
- `priority` (opsiyonel, default `normal`): `low|normal|high`. Yüksek
  öncelik önce işlenir.

Header:
- `Authorization: Bearer <KEY>` (zorunlu)
- `Idempotency-Key: <opaque>` (opsiyonel, 24h window)

Yanıt **201** Created:

```json
{
  "id": "batch_01HZK9P0YQ8Q4T7K3R5N9XB2M0",
  "object": "batch",
  "status": "queued",
  "request_counts": {"total":1,"completed":0,"failed":0},
  "priority": "normal",
  "created_at": "2026-05-20T19:15:00",
  "started_at": null,
  "finished_at": null,
  "metadata": {"source":"nightly","tag":"2026-05-20"},
  "callback_url": "https://example.com/webhooks/batch"
}
```

Hata kodları:

| HTTP | code | Anlam |
|---|---|---|
| 400 | `duplicate_custom_id` | Aynı custom_id iki kez |
| 400 | `payload_too_large` | Body > 5MB |
| 400 | `metadata_too_large` | metadata > 2KB |
| 400 | (zod) | items boş, max_tokens negatif, vs. |
| 401 | `authentication_error` | Bearer yanlış/eksik |
| 409 | `idempotency_key_conflict` | Aynı key, farklı body |
| 429 | `too_many_active_batches` | Aynı anda >10 aktif batch |

---

## 2. GET /v1/batches/:id

Durum sorgulama. `status` döngüsü:

- `queued` → hiç item işlenmedi
- `processing` → en az 1 item başladı, kalan pending var
- `completed` → terminal: tüm itemlar done/error
- `cancelled` → terminal: kullanıcı iptal etti
- `failed` → terminal: kritik hata (nadir)

Yanıt POST ile aynı şema.

---

## 3. GET /v1/batches

```
GET /v1/batches?status=processing&limit=50&cursor=batch_xxx
```

Yanıt: `{"data":[...], "next_cursor":"batch_..." or null}`. Cursor batch
id'sinin azalan sırasıyla pagination.

---

## 4. GET /v1/batches/:id/results

Content-Type `application/x-ndjson`. Her satır bir item:

```json
{"custom_id":"row-1","position":0,"status":"done","latency_ms":156,"attempt":1,"response":{"id":"chatcmpl-...","choices":[...],"usage":{...},"_routed_via":{"platform":"groq","model":"llama-3.3-70b-versatile"}}}
{"custom_id":"row-2","position":1,"status":"error","latency_ms":62000,"attempt":3,"error":{"message":"All providers rate-limited","type":"provider_error"}}
{"custom_id":"row-3","position":2,"status":"cancelled","latency_ms":0,"attempt":0,"error":{"message":"cancelled before processing","type":"cancelled"}}
```

- Batch terminal olmasa bile o ana kadar done/error/cancelled item'lar
  döner (partial).
- `?since=<position>` ile o pozisyondan SONRAKILER. Incremental polling
  için ideal.
- Sıralama her zaman `position ASC`.

---

## 5. DELETE /v1/batches/:id

Yanıt:
```json
{"id":"batch_...","status":"cancelled","cancelled_pending":42}
```

- Pending itemlar `cancelled`.
- Inflight olanlar bitene kadar çalışır; bitince done/error olarak yazılır
  ama batch.status='cancelled' kaldığı için counter güncellemez.
- Terminal batch → 409 `already_terminal`.

---

## 6. Webhook doğrulama

`callback_url` set ise batch finalize olunca:

```http
POST <callback_url>
Content-Type: application/json
X-MyLLM-Signature: sha256=<hex>

{
  "id": "batch_...",
  "object": "batch.event",
  "status": "completed",
  "request_counts": {"total":50,"completed":48,"failed":2},
  "finished_at": "2026-05-20T19:22:00",
  "metadata": {...},
  "results_url": "https://myapi.example.com/v1/batches/<id>/results"
}
```

HMAC-SHA256 imza, secret = senin unified API key.

Python doğrulama:
```python
import hmac, hashlib
def verify(raw_body: bytes, sig_header: str, key: str) -> bool:
    expected = "sha256=" + hmac.new(key.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_header)
```

PHP doğrulama:
```php
$expected = 'sha256=' . hash_hmac('sha256', $rawBody, $key);
if (!hash_equals($expected, $request->header('X-MyLLM-Signature'))) abort(401);
```

3 deneme, exponential backoff (0s / 5s / 30s / 5min). 2xx dönmezse
`callback_status='failed'`. Webhook DEĞİL → results_url'i pollla.

---

## 7. Idempotency

`Idempotency-Key` header (opaque string, retry-safe POST için).

- Aynı key + aynı body, 24h içinde → mevcut batch döner (HTTP 200).
- Aynı key + farklı body, 24h içinde → HTTP 409
  `idempotency_key_conflict`.
- Key yoksa veya 24h geçtiyse → yeni batch yaratılır.

Tipik kullanım: cron job retry'da çift batch oluşmasın diye.

```bash
curl -X POST .../v1/batches \
  -H "Idempotency-Key: nightly-2026-05-20" \
  -H "Authorization: Bearer ..." \
  -d '{"items":[...]}'
```

---

## 8. Limitler

| Limit | Varsayılan |
|---|---|
| Max item / batch | 1000 |
| Max body | 5 MB |
| Max active batch / unified key | 10 |
| Max custom_id length | 256 char |
| Item retry | 3 (retryable hatalar) |
| Worker concurrency | 4 |
| Retention | 7 gün (finalize sonrası) |
| Webhook attempts | 3 |

Operatör env override edebilir (`MYLLM_BATCH_*`). Yukarıdaki sayılar default.

---

## 9. End-to-end örnek (Python)

```python
import time, requests
KEY  = "<UNIFIED_API_KEY>"
BASE = "https://myapi.example.com"
H    = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

WORDS = ["house","water","tree","book","sun","moon","dog","cat","car","road"]
items = [{"custom_id": f"r{i}",
          "body": {"messages":[{"role":"user","content":f"Translate to Turkish: {w}"}],
                   "max_tokens": 40}}
         for i, w in enumerate(WORDS)]

r = requests.post(f"{BASE}/v1/batches",
                  headers={**H, "Idempotency-Key":"sample-2026-05-20"},
                  json={"items": items, "metadata":{"source":"sample"}})
r.raise_for_status()
bid = r.json()["id"]
print("created:", bid)

while True:
    s = requests.get(f"{BASE}/v1/batches/{bid}", headers=H).json()
    print(s["status"], s["request_counts"])
    if s["status"] in ("completed","failed","cancelled"): break
    time.sleep(3)

with requests.get(f"{BASE}/v1/batches/{bid}/results", headers=H, stream=True) as resp:
    for line in resp.iter_lines():
        if not line: continue
        row = __import__("json").loads(line.decode())
        if row["status"] == "done":
            print(row["custom_id"], "→", row["response"]["choices"][0]["message"]["content"])
        else:
            print(row["custom_id"], "FAIL:", row.get("error"))
```

---

## 10. PHP / Laravel örneği

```php
use Illuminate\Support\Facades\Http;

$base = 'https://myapi.example.com';
$key  = config('services.myllm.key');

$items = collect($products)->map(fn($p) => [
    'custom_id' => "p{$p->id}",
    'body' => [
        'messages' => [['role'=>'user','content'=>"Slogan üret: {$p->name}"]],
        'max_tokens' => 60,
    ],
])->all();

$create = Http::withToken($key)
    ->withHeaders(['Idempotency-Key' => "slogan-".now()->toDateString()])
    ->post("$base/v1/batches", [
        'items' => $items,
        'metadata' => ['source' => 'slogan-nightly'],
        'callback_url' => route('webhooks.myllm-batch'),
    ])->throw()->json();

$bid = $create['id'];
```

Webhook route:
```php
Route::post('/webhooks/myllm-batch', function (Request $req) {
    $raw = $req->getContent();
    $sig = $req->header('X-MyLLM-Signature');
    $exp = 'sha256=' . hash_hmac('sha256', $raw, config('services.myllm.key'));
    abort_unless(hash_equals($exp, $sig), 401);
    // … parse $req->json() and fetch results_url
});
```

---

## 11. Hata fallback davranışı (önemli)

Her batch item runChatCompletion'dan geçer → sync proxy'le AYNI router +
cascade + cooldown. Bir provider/key gün/dakika/quota'ya takılırsa worker
otomatik diğer key'i ya da sıradaki fallback model'i dener. Item başına
3 retry hakkı vardır (retryable hatalar için: 429/5xx/network), sonra
`status=error` olur. Hiç sağlayıcı yoksa item `error` ile biter, batch
yine `completed` olarak finalize edilir (counts.failed artar).

UTC midnight'ta günlük cooldown'lar otomatik kalkar → kotaya doymuş
key/model sonraki gün tekrar yarışır.
