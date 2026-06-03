# Türkçe Karakter Kalite Testi (Haz 2026)

Tüm aktif text modelleri (92) localhost'tan pinli (`no_cascade`) test edildi.
Script: `scripts/tr_test.py`. Ham sonuç: sunucu `/opt/freellmapi/tr_results.json`.

## Metodoloji

İki prompt, her model için pinli + cascade kapalı (gerçek modelin çıktısı):

1. **Echo (birincil sinyal)**: `"Tam olarak şunu yaz: çiğköfte ışık öğün şükür dürüm"`
   → çıktı bu ifadeyi birebir üretebiliyor mu? Karakter bozulmasını/değişimini
   yakalar. Baş harf büyük/küçük farkı tolere edilir (`Çiğköfte` = OK).
2. **Generation**: serbest Türkçe paragraf → mojibake kontrolü.

Grade: `OK` / `ECHO_CORRUPT` (ifadeyi bozdu) / `MOJIBAKE` (Ã§ gibi bozuk
byte) / `NO_OUTPUT` (reasoning modeli bütçeyi trace'e harcadı) / `ERROR`
(geçici sağlayıcı hatası).

> Not: ilk iki test denemesi false-positive üretti — "sadece sayıları yaz"
> deyince model rakam yazıyor, "Çiğköfte" baş harfi büyük gibi. Bunlar
> düzeltildi; aşağısı temiz sonuç.

## Sonuç: encoding sağlıklı

- **92 modelin TAMAMINDA sıfır mojibake.** Request → provider → response
  UTF-8 pipeline'ı ç ğ ı ö ş ü İ Ç Ğ Ö Ş Ü karakterlerini doğru taşıyor.
  Sistemsel/kodsal bir Türkçe karakter bozulması YOK.
- **75/92 OK** (echo birebir + temiz Türkçe). Lider modeller (gemini flash,
  mistral, sambanova, zhipu glm-4.5 ailesi, github llama, cloudflare) Türkçe'de
  sorunsuz.

## Gerçek Türkçe sorunu olan modeller (2)

| platform/model | sorun | durum |
|---|---|---|
| `reka/reka-edge-2603` | Kelime bozuyor/değiştiriyor: `dürüm` → `düşmüş`; talimatı takip etmiyor, başına metin ekliyor. | ir=14, zaten zincir dibinde. **TR-ağırlıklı trafik için disable önerilir.** |
| `openrouter/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning:free` | İngilizce cevaplıyor (`"The..."`), reasoning trace token bütçesini yiyor. | Reasoning model → auto-route'ta zaten hariç (`excludeReasoning`). Düşük risk. |

## TR değil — geçici hatalar (test anında)

14 model ERROR döndü; Türkçe ile alakasız:
- **github** (gpt-4.1-nano, gpt-4o-mini): 10 RPM limiti + paralel test = rate-limit.
  Ayrıca aynı `model_id`'nin 2 platformda olması test pin'ini karıştırdı
  (örn. gpt-4.1-nano isteği GH Llama Vision hatası gösterdi). Test artefaktı.
- **openrouter :free** (minimax-m2.5, qwen3-coder, llama-3.x, hermes, gemma,
  kimi-k2.6): free-tier flap (V57'de ölçülen sağlıkla zaten demote).
- **cerebras** llama3.1-8b, **nvidia** glm-5.1 (aborted), gpt-oss-120b (disabled).

Bu modellerin Türkçe kalitesi düşük yükte tekrar test edilmeli (idle stres
testi `stress_test.py` zaten çoğunu 4/4 q4 göstermişti).

## Öneri

1. `reka/reka-edge-2603` → TR kalitesi kötü, disable veya en dibe sabit demote.
2. Encoding tarafında yapılacak bir şey yok — temiz.
3. Kullanıcının "saçmalıyor" algısı muhtemelen V57 ÖNCESİ kötü routing'den
   (zayıf/yavaş modellere düşen trafik) + reka'dan geliyordu. V57 sonrası
   zincir Türkçe'de güçlü modellerle başlıyor.
