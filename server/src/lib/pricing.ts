import { getDb } from '../db/index.js';

// ---------------------------------------------------------------------------
// In-memory price cache
// key = "platform::modelId"
// ---------------------------------------------------------------------------
interface PriceEntry {
  in: number;      // USD per 1M input tokens
  out: number;     // USD per 1M output tokens
  perCall: number; // USD per call (image/audio)
}

let priceCache: Map<string, PriceEntry> | null = null;

function getDefaults(): { in: number; out: number; perCall: number } {
  try {
    const db = getDb();
    const get = (key: string, fallback: number): number => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      if (!row) return fallback;
      const n = parseFloat(row.value);
      return isFinite(n) ? n : fallback;
    };
    return {
      in:      get('default_price_input_per_1m',  0.25),
      out:     get('default_price_output_per_1m', 1.50),
      perCall: get('default_price_per_call',       0.04),
    };
  } catch {
    return { in: 0.25, out: 1.50, perCall: 0.04 };
  }
}

function loadCache(): Map<string, PriceEntry> {
  const map = new Map<string, PriceEntry>();
  try {
    const db = getDb();
    const defaults = getDefaults();
    const rows = db.prepare(
      'SELECT platform, model_id, price_input_per_1m, price_output_per_1m, price_per_call FROM models'
    ).all() as Array<{
      platform: string;
      model_id: string;
      price_input_per_1m: number | null;
      price_output_per_1m: number | null;
      price_per_call: number | null;
    }>;
    for (const r of rows) {
      map.set(`${r.platform}::${r.model_id}`, {
        in:      r.price_input_per_1m  ?? defaults.in,
        out:     r.price_output_per_1m ?? defaults.out,
        perCall: r.price_per_call      ?? defaults.perCall,
      });
    }
  } catch {
    // If DB is not available yet, return empty — computeCostMicro will fall
    // back to defaults inline.
  }
  return map;
}

export function invalidatePriceCache(): void {
  priceCache = null;
}

function getEntry(platform: string, modelId: string): PriceEntry {
  if (!priceCache) priceCache = loadCache();
  return priceCache.get(`${platform}::${modelId}`) ?? (() => {
    const d = getDefaults();
    return { in: d.in, out: d.out, perCall: d.perCall };
  })();
}

// ---------------------------------------------------------------------------
// Non-text modalities that are billed per-call, not per-token
// ---------------------------------------------------------------------------
const PER_CALL_MODALITIES = new Set([
  'image_gen', 'image_edit', 'image_inpaint',
  'audio_stt', 'audio_tts',
]);

function isPerCallModality(modality: string | null | undefined): boolean {
  if (!modality || modality === 'text') return false;
  return PER_CALL_MODALITIES.has(modality);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export function computeCostMicro(args: {
  platform: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  modality?: string | null;
}): number {
  try {
    const entry = getEntry(args.platform, args.modelId);
    if (isPerCallModality(args.modality)) {
      return Math.round(entry.perCall * 1_000_000);
    }
    const cost =
      args.inputTokens  * entry.in  +
      args.outputTokens * entry.out;
    return Math.round(cost);
  } catch {
    return 0;
  }
}
