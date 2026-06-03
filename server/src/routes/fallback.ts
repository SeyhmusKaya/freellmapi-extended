import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties } from '../services/router.js';
import { applyQualityOrder } from '../lib/qualityRank.js';

export const fallbackRouter = Router();

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC
  `).all() as any[];

  // Count enabled keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
  budget: "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC",
};

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const db = getDb();

  // `quality` is a composite preset: it blends intelligence/speed with
  // RPM/RPD capacity and runs a provider-diversity pass, which cannot be
  // expressed as a plain SQL ORDER BY. Delegate to the shared scorer.
  if (preset === 'quality') {
    applyQualityOrder(db);
    res.json({ success: true, preset });
    return;
  }

  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: quality, intelligence, speed, budget` } });
    return;
  }

  const models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar.
//
// Returns separate `text` and `images` sections so the UI can render two
// independent gauges. Text uses real token counts (input+output); image-gen
// uses neuron counts as a proxy for "tokens used" (1 image ≈ neurons_per_call,
// from CF's documented neuron budget). `imagesGenerated` is also tracked as
// a per-model success count, which is more meaningful than neuron sum for
// most operator dashboards.
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  // Keys per platform — used to scale text budgets (more keys = more quota).
  // Pollinations is keyless: synthesize a key count of 1 so its rows still
  // pass the `platformSet` filter.
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) AS cnt
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; cnt: number }[];
  const keyCountByPlatform = new Map(keyCounts.map(r => [r.platform, r.cnt]));
  // Keyless platforms (e.g. Pollinations) still appear in routing even with
  // zero api_keys rows. Inject them so the budget view doesn't hide them.
  const keylessPlatforms = db.prepare(`
    SELECT DISTINCT platform FROM models WHERE enabled = 1 AND platform = 'pollinations'
  `).all() as { platform: string }[];
  for (const k of keylessPlatforms) if (!keyCountByPlatform.has(k.platform)) keyCountByPlatform.set(k.platform, 1);
  const platformSet = new Set(keyCountByPlatform.keys());

  // Pull every enabled (model + fallback row) with the new modality +
  // neurons_per_call columns so we can split text from images.
  const models = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget,
           m.tpd_limit, m.modality, m.neurons_per_call, fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = 1 AND fc.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as Array<{
    platform: string; model_id: string; display_name: string;
    monthly_token_budget: string; tpd_limit: number | null;
    modality: string | null; neurons_per_call: number | null;
    priority: number;
  }>;

  // Per-model usage (success rows only). Two windows: month-to-date, today.
  // Maps keyed by "platform|model_id".
  const monthlyByModel = new Map<string, number>();
  const monthlyCountByModel = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT platform, model_id,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS used,
           COUNT(*) AS cnt
      FROM requests
     WHERE status = 'success' AND created_at >= datetime('now', 'start of month')
     GROUP BY platform, model_id
  `).all() as Array<{ platform: string; model_id: string; used: number; cnt: number }>) {
    monthlyByModel.set(`${r.platform}|${r.model_id}`, r.used);
    monthlyCountByModel.set(`${r.platform}|${r.model_id}`, r.cnt);
  }
  const dailyByModel = new Map<string, number>();
  const dailyCountByModel = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT platform, model_id,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS used,
           COUNT(*) AS cnt
      FROM requests
     WHERE status = 'success' AND created_at >= datetime('now', 'start of day')
     GROUP BY platform, model_id
  `).all() as Array<{ platform: string; model_id: string; used: number; cnt: number }>) {
    dailyByModel.set(`${r.platform}|${r.model_id}`, r.used);
    dailyCountByModel.set(`${r.platform}|${r.model_id}`, r.cnt);
  }

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  // ---- TEXT bucket ----
  const textRows = models
    .filter(m => platformSet.has(m.platform))
    .filter(m => (m.modality ?? 'text') === 'text')
    .map(m => {
      const keys = keyCountByPlatform.get(m.platform) ?? 1;
      const monthly = parseBudget(m.monthly_token_budget);
      const dailyPerKey = m.tpd_limit && m.tpd_limit > 0 ? m.tpd_limit : monthly / 30;
      const usedKey = `${m.platform}|${m.model_id}`;
      // Some providers (NVIDIA NIM) have NO token quota — only an RPM cap.
      // Their monthly_token_budget is a non-numeric label ('~RPM-capped')
      // that parseBudget() returns 0 for. Flag them so the UI shows ∞
      // instead of a misleading "0".
      const unlimited = monthly === 0;
      return {
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        modality: 'text' as const,
        unlimited,
        budget: monthly * keys,
        dailyBudget: Math.round(dailyPerKey * keys),
        monthlyUsed: monthlyByModel.get(usedKey) ?? 0,
        dailyUsed: dailyByModel.get(usedKey) ?? 0,
        keyCount: keys,
      };
    });

  const textTotalBudget = textRows.reduce((s, m) => s + m.budget, 0);
  const textTotalDailyBudget = textRows.reduce((s, m) => s + m.dailyBudget, 0);
  const textTotalMonthlyUsed = textRows.reduce((s, m) => s + m.monthlyUsed, 0);
  const textTotalDailyUsed = textRows.reduce((s, m) => s + m.dailyUsed, 0);

  // ---- IMAGE bucket ----
  // Daily budget = neurons_per_call × imagesPerDayCap. For CF the cap is the
  // 10K Neurons/day shared free pool scaled by key count: ceil(10000 / np).
  // For keyless providers (Pollinations) we cap at 1500 images/day soft.
  const CF_NEURONS_PER_KEY_PER_DAY = 10000;
  const POLLINATIONS_IMAGES_PER_DAY = 1500;
  const imageRows = models
    .filter(m => platformSet.has(m.platform))
    .filter(m => m.modality === 'image_gen')
    .map(m => {
      const keys = keyCountByPlatform.get(m.platform) ?? 1;
      const np = m.neurons_per_call ?? 80;
      const usedKey = `${m.platform}|${m.model_id}`;

      let dailyBudgetImages: number;
      if (m.platform === 'cloudflare') {
        // images/day = (10K neurons × keys) / neurons_per_call
        dailyBudgetImages = Math.floor((CF_NEURONS_PER_KEY_PER_DAY * keys) / np);
      } else {
        // Pollinations / keyless / future
        dailyBudgetImages = POLLINATIONS_IMAGES_PER_DAY;
      }
      const monthlyBudgetImages = dailyBudgetImages * 30;

      return {
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        modality: 'image_gen' as const,
        neuronsPerCall: np,
        budget: monthlyBudgetImages,                    // in IMAGES
        dailyBudget: dailyBudgetImages,                 // in IMAGES
        monthlyUsed: monthlyCountByModel.get(usedKey) ?? 0,
        dailyUsed: dailyCountByModel.get(usedKey) ?? 0,
        keyCount: keys,
      };
    });

  const imageTotalBudget = imageRows.reduce((s, m) => s + m.budget, 0);
  const imageTotalDailyBudget = imageRows.reduce((s, m) => s + m.dailyBudget, 0);
  const imageTotalMonthlyUsed = imageRows.reduce((s, m) => s + m.monthlyUsed, 0);
  const imageTotalDailyUsed = imageRows.reduce((s, m) => s + m.dailyUsed, 0);

  // ---- EMBEDDINGS bucket (V30) ----
  // Capacity unit = "embedding calls/day". Each provider's free tier:
  //   cloudflare BGE: ~1000-2000 calls/key/day (5-10 neurons/call within 10K)
  //   google gemini-embedding-001: 1500 RPD free (per key, RPM-capped)
  //   cohere v3/v4: ~33 calls/day (1000/month / 30); per key
  //   mistral mistral-embed: ~2000/day soft
  //   zhipu embedding-3/2: ~5000/day
  //   github text-embedding-3-large: ~500/day (Azure monthly quota / 30)
  const EMBED_DAILY_CAP_PER_KEY: Record<string, number> = {
    cloudflare: 1500,   // ~10K neurons / ~7 neurons-per-call
    google: 1500,       // RPD free tier
    cohere: 33,         // 1000/mo trial / 30
    mistral: 2000,
    zhipu: 5000,
    github: 500,
  };
  const embeddingRows = models
    .filter(m => platformSet.has(m.platform))
    .filter(m => m.modality === 'embedding')
    .map(m => {
      const keys = keyCountByPlatform.get(m.platform) ?? 1;
      const usedKey = `${m.platform}|${m.model_id}`;
      const perKey = EMBED_DAILY_CAP_PER_KEY[m.platform] ?? 500;
      const dailyBudgetCalls = perKey * keys;
      return {
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        modality: 'embedding' as const,
        budget: dailyBudgetCalls * 30,           // monthly = daily × 30 (rough)
        dailyBudget: dailyBudgetCalls,           // in CALLS/day
        monthlyUsed: monthlyCountByModel.get(usedKey) ?? 0,
        dailyUsed: dailyCountByModel.get(usedKey) ?? 0,
        keyCount: keys,
      };
    });

  const embeddingTotalBudget = embeddingRows.reduce((s, m) => s + m.budget, 0);
  const embeddingTotalDailyBudget = embeddingRows.reduce((s, m) => s + m.dailyBudget, 0);
  const embeddingTotalMonthlyUsed = embeddingRows.reduce((s, m) => s + m.monthlyUsed, 0);
  const embeddingTotalDailyUsed = embeddingRows.reduce((s, m) => s + m.dailyUsed, 0);

  // ---- AUDIO_TTS bucket (V32) ----
  // Cloudflare MeloTTS uses neurons (~30 per call). 10K neurons/key/day ⇒
  // ~333 calls/key/day. Scales linearly with key count.
  const TTS_DAILY_CAP_PER_KEY: Record<string, number> = {
    cloudflare: Math.floor(CF_NEURONS_PER_KEY_PER_DAY / 30),
  };
  const ttsRows = models
    .filter(m => platformSet.has(m.platform))
    .filter(m => m.modality === 'audio_tts')
    .map(m => {
      const keys = keyCountByPlatform.get(m.platform) ?? 1;
      const usedKey = `${m.platform}|${m.model_id}`;
      const perKey = TTS_DAILY_CAP_PER_KEY[m.platform] ?? 200;
      const dailyBudgetCalls = perKey * keys;
      return {
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        modality: 'audio_tts' as const,
        budget: dailyBudgetCalls * 30,
        dailyBudget: dailyBudgetCalls,
        monthlyUsed: monthlyCountByModel.get(usedKey) ?? 0,
        dailyUsed: dailyCountByModel.get(usedKey) ?? 0,
        keyCount: keys,
      };
    });
  const ttsTotalBudget = ttsRows.reduce((s, m) => s + m.budget, 0);
  const ttsTotalDailyBudget = ttsRows.reduce((s, m) => s + m.dailyBudget, 0);
  const ttsTotalMonthlyUsed = ttsRows.reduce((s, m) => s + m.monthlyUsed, 0);
  const ttsTotalDailyUsed = ttsRows.reduce((s, m) => s + m.dailyUsed, 0);

  // ---- AUDIO_STT bucket (V21) ----
  // Cloudflare Whisper transcription. Each call consumes neurons roughly
  // proportional to audio length; assume a conservative ~50 neurons/call
  // average → 10K neurons/key/day ⇒ ~200 calls/key/day.
  const STT_DAILY_CAP_PER_KEY: Record<string, number> = {
    cloudflare: Math.floor(CF_NEURONS_PER_KEY_PER_DAY / 50),
  };
  const sttRows = models
    .filter(m => platformSet.has(m.platform))
    .filter(m => m.modality === 'audio_stt')
    .map(m => {
      const keys = keyCountByPlatform.get(m.platform) ?? 1;
      const usedKey = `${m.platform}|${m.model_id}`;
      const perKey = STT_DAILY_CAP_PER_KEY[m.platform] ?? 150;
      const dailyBudgetCalls = perKey * keys;
      return {
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        modality: 'audio_stt' as const,
        budget: dailyBudgetCalls * 30,
        dailyBudget: dailyBudgetCalls,
        monthlyUsed: monthlyCountByModel.get(usedKey) ?? 0,
        dailyUsed: dailyCountByModel.get(usedKey) ?? 0,
        keyCount: keys,
      };
    });
  const sttTotalBudget = sttRows.reduce((s, m) => s + m.budget, 0);
  const sttTotalDailyBudget = sttRows.reduce((s, m) => s + m.dailyBudget, 0);
  const sttTotalMonthlyUsed = sttRows.reduce((s, m) => s + m.monthlyUsed, 0);
  const sttTotalDailyUsed = sttRows.reduce((s, m) => s + m.dailyUsed, 0);

  // ---- RERANK bucket (V34) ----
  // Cohere trial: 1000 calls/MONTH per key (not per day). Express both windows
  // off that single monthly cap: dailyBudget = monthly / 30, scaled by keys.
  const RERANK_MONTHLY_CAP_PER_KEY: Record<string, number> = {
    cohere: 1000,
  };
  const rerankRows = models
    .filter(m => platformSet.has(m.platform))
    .filter(m => m.modality === 'rerank')
    .map(m => {
      const keys = keyCountByPlatform.get(m.platform) ?? 1;
      const usedKey = `${m.platform}|${m.model_id}`;
      const perKeyMonthly = RERANK_MONTHLY_CAP_PER_KEY[m.platform] ?? 1000;
      const monthlyBudgetCalls = perKeyMonthly * keys;
      const dailyBudgetCalls = Math.round(monthlyBudgetCalls / 30);
      return {
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        modality: 'rerank' as const,
        budget: monthlyBudgetCalls,
        dailyBudget: dailyBudgetCalls,
        monthlyUsed: monthlyCountByModel.get(usedKey) ?? 0,
        dailyUsed: dailyCountByModel.get(usedKey) ?? 0,
        keyCount: keys,
      };
    });
  const rerankTotalBudget = rerankRows.reduce((s, m) => s + m.budget, 0);
  const rerankTotalDailyBudget = rerankRows.reduce((s, m) => s + m.dailyBudget, 0);
  const rerankTotalMonthlyUsed = rerankRows.reduce((s, m) => s + m.monthlyUsed, 0);
  const rerankTotalDailyUsed = rerankRows.reduce((s, m) => s + m.dailyUsed, 0);

  res.json({
    // Legacy top-level fields (text-only) preserved for backward compatibility
    // with the existing FallbackPage code that didn't know about image-gen.
    totalBudget: textTotalBudget,
    totalUsed: textTotalMonthlyUsed,
    totalDailyBudget: textTotalDailyBudget,
    totalDailyUsed: textTotalDailyUsed,
    models: textRows,

    // New: explicit per-modality blocks.
    text: {
      totalBudget: textTotalBudget,
      totalDailyBudget: textTotalDailyBudget,
      totalMonthlyUsed: textTotalMonthlyUsed,
      totalDailyUsed: textTotalDailyUsed,
      models: textRows,
    },
    images: {
      // budgets + usage are in IMAGES, not tokens.
      totalBudget: imageTotalBudget,
      totalDailyBudget: imageTotalDailyBudget,
      totalMonthlyUsed: imageTotalMonthlyUsed,
      totalDailyUsed: imageTotalDailyUsed,
      models: imageRows,
    },
    embeddings: {
      // budgets + usage are in CALLS, not tokens. One call may contain N
      // inputs (native batch); we count it as 1 against the daily cap.
      totalBudget: embeddingTotalBudget,
      totalDailyBudget: embeddingTotalDailyBudget,
      totalMonthlyUsed: embeddingTotalMonthlyUsed,
      totalDailyUsed: embeddingTotalDailyUsed,
      models: embeddingRows,
    },
    audio_tts: {
      // budgets + usage are in CALLS/day. CF MeloTTS ≈ 30 neurons each;
      // 10K neurons/key/day ⇒ ~333/key/day.
      totalBudget: ttsTotalBudget,
      totalDailyBudget: ttsTotalDailyBudget,
      totalMonthlyUsed: ttsTotalMonthlyUsed,
      totalDailyUsed: ttsTotalDailyUsed,
      models: ttsRows,
    },
    audio_stt: {
      // budgets + usage are in CALLS/day. CF Whisper ≈ 50 neurons/call avg.
      totalBudget: sttTotalBudget,
      totalDailyBudget: sttTotalDailyBudget,
      totalMonthlyUsed: sttTotalMonthlyUsed,
      totalDailyUsed: sttTotalDailyUsed,
      models: sttRows,
    },
    rerank: {
      // budgets + usage are in CALLS. Cohere trial = 1000/MONTH per key;
      // dailyBudget exposed as monthly/30 so the daily bar still renders.
      totalBudget: rerankTotalBudget,
      totalDailyBudget: rerankTotalDailyBudget,
      totalMonthlyUsed: rerankTotalMonthlyUsed,
      totalDailyUsed: rerankTotalDailyUsed,
      models: rerankRows,
    },
  });
});
