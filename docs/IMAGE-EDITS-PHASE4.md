# MyLLM Image Edits Faz 4

Hedef: OpenAI SDK ile birebir uyum + outpainting. Faz 1-3'te JSON-only
endpoints kullanıldı; OpenAI Python/Node SDK'ları multipart/form-data
gönderir, bu yüzden caller "import openai; client.images.edit(...)"
yapamıyor. Faz 4 multipart desteği ekler + bonus outpainting endpoint.

> ControlNet: Cloudflare Workers AI'da yok. Faz 5'e ertelenmiştir.

---

## 1. multipart/form-data desteği

### Etkilenen endpoint'ler
- POST /v1/images/generations (Faz 1 — prompt yalnız, ufak gain)
- POST /v1/images/edits          (Faz 4 zorunlu — image + mask binary)
- POST /v1/images/variations     (Faz 4 — image binary)
- POST /v1/audio/transcriptions  (Faz 4 — OpenAI Whisper SDK uyumu)

### Strateji
- `multer` npm paketi ile memory storage.
- Mevcut JSON path ETKİLENMEZ — backward compat.
- Content-Type sniff: `multipart/form-data` ise multer, değilse mevcut json.
- multer fields: `image`, `mask`, `audio` (binary); diğerleri (`prompt`,
  `model`, `n`, `size`, `response_format`, `language`, `seed`, ...) text.
- Binary File buffer → `data:<mime>;base64,<...>` çevirimi sonra mevcut
  runImageEdit / runAudioTranscription'a aynı şekilde gider.

### Limitler
- multer file size limit 25MB per file (mevcut JSON limit ile aynı).
- 4 file max (image + mask + image + image, vb.).

---

## 2. Outpainting

Caller'a görsel kenarlarından N piksel uzatma imkanı. Inpainting modelini
generic "white outer ring" mask ile kullanır.

### Endpoint: POST /v1/images/outpaint

Body (JSON veya multipart):
```json
{
  "image": "data:image/png;base64,...",
  "prompt": "a wider scenery, mountains in distance",
  "direction": "all" | "left" | "right" | "top" | "bottom",
  "pixels": 256,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Implementation:
1. Caller image'i decode → Sharp ile resize ve canvas'a yapıştır
   (image kanvasın merkezinde, kenarlar şeffaf).
2. Mask = otomatik oluşturulan beyaz outer ring (kenarlar) + siyah merkez.
3. CF SD-1.5-inpainting'e gönder → outpainted image dön.
4. Result base64 / url path mevcut storage ile.

> Sharp halihazırda gerekmiyor — basit PNG yapısı için Buffer manipülasyonu
> yeterli ya da paket eklenir. Faz 4'te `sharp` ekle (npm).

### Limitler
- pixels: 32..512 (üst sınır image-size'a bağlı)
- direction: 5 değer
- input image min 256x256

---

## 3. Dosya listesi & LOC

| Dosya | Yeni/Edit | LOC |
|---|---|---|
| `docs/IMAGE-EDITS-PHASE4.md` | YENİ | ~150 |
| `server/package.json` | edit (multer + sharp) | +2 |
| `server/src/lib/multipartHelper.ts` | YENİ | ~80 |
| `server/src/routes/images.ts` | edit (multipart middleware) | +60 |
| `server/src/routes/audio.ts` | edit | +30 |
| `server/src/lib/runImageOutpaint.ts` | YENİ | ~120 |
| Tests (3 dosya) | YENİ | ~280 |
| CLAUDE.md + API-KULLANIM.md | edit | +80 |

**~800 LOC** (test + doc dahil).

---

## 4. Test planı

| Dosya | Test |
|---|---|
| `lib/multipart-helper.test.ts` | Buffer→data URL, mime sniff, missing field |
| `routes/images-multipart.test.ts` | POST multipart edits routes correctly; field mapping; image+mask binary delivery |
| `routes/audio-multipart.test.ts` | Whisper multipart accepts file field |
| `lib/outpaint.test.ts` | Mask auto-generation, dimension calc, direction logic |
| `routes/outpaint.test.ts` | E2E POST /v1/images/outpaint |

---

## 5. Rollout

1. `npm i multer sharp @types/multer` in server/
2. Implement multipartHelper + endpoint wrap
3. Outpainting endpoint
4. Tests
5. `bash scripts/deploy.sh`
6. Test with OpenAI Python SDK:
   ```python
   from openai import OpenAI
   c = OpenAI(base_url='https://myapi.example.com/v1', api_key='<KEY>')
   resp = c.images.edit(image=open('cat.png','rb'), prompt='add a hat')
   ```

---

## 6. Faz 5 (kısmi — politika uyumlu kısımlar)

### 6.1 Tamamlandı — Mask painter UI (Mayıs 2026)

`client/src/pages/playground/ImageEditPanel.tsx` — PlaygroundPage içinde
Chat / Image edit tab switcher. Image edit panelinde:

- **Inpaint mode**: source görsel canvas'a yüklenir, üst katmana
  `<canvas>` overlay ile fırça boyalı mask çizilir. Submit'te overlay'den
  siyah-beyaz PNG mask üretilir (`alpha > 16 → black`), `image` + `mask` +
  `prompt` + `strength` ile `/v1/images/edits`'e POST.
- **Outpaint mode**: source görsel + direction (left/right/top/bottom/all) +
  pixels (32-512) ile `/v1/images/outpaint`'e POST. Server'da sharp ile
  canvas extend + auto mask yapılır.
- Result panel `b64_json` PNG'yi gösterir, download butonu mevcut.
- Görsel `MAX_DIM=768`'e ölçeklendirilir (CF SD-1.5 inpainting sınırı).

UI: teal gradient header, dashed-border drop zone, brush size slider,
strength slider (0.1-1.0), `_routed_via` ve latency badge'i.

### 6.2 Politika gereği SKIP

- **ControlNet (depth/edge guidance)**: CF Workers AI expose etmiyor,
  Replicate/HF gerek → trial-only credit politikası gereği eklenmedi.
- **Video generation**: Aynı durum, free provider yok.
- **Dedicated image variations model**: CF'de yok, mevcut SD-1.5 fallback
  yeterli (Faz 3'te `/v1/images/variations` zaten çalışıyor).
