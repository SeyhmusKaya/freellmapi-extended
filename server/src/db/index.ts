import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey, encrypt, decrypt } from '../lib/crypto.js';
import { applyQualityOrder } from '../lib/qualityRank.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  const isMemory = resolvedPath === ':memory:';

  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = new Database(resolvedPath);
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
    // synchronous=NORMAL is the recommended pairing with WAL: same crash
    // safety (a power loss can only lose the last transaction, never corrupt
    // the DB) but markedly faster writes than FULL.
    db.pragma('synchronous = NORMAL');
    // Without a busy timeout, a concurrent writer (batch worker @ 4 + sync
    // request logging) hitting a locked DB throws SQLITE_BUSY immediately.
    // 5s lets the lock holder finish instead of erroring the request.
    db.pragma('busy_timeout = 5000');
  }
  db.pragma('foreign_keys = ON');

  createTables(db);
  initEncryptionKey(db);
  seedModels(db);
  migrateModels(db);
  migrateModelsV2(db);
  migrateModelsV3Ranks(db);
  migrateModelsV4(db);
  migrateModelsV5(db);
  migrateModelsV6(db);
  migrateModelsV7(db);
  migrateModelsV8(db);
  migrateModelsV9(db);
  migrateModelsV10(db);
  migrateModelsV11Vision(db);
  migrateModelsV12JsonMode(db);
  migrateModelsV13DeadModels(db);
  migrateRequestsV14Diagnostics(db);
  migrateModelsV15ImageGen(db);
  migrateModelsV16Pollinations(db);
  migrateImageFilesV17(db);
  migrateModelsV18Img2Img(db);
  migrateModelsV19PollinationsExtras(db);
  migrateModelsV20ZhipuCogView(db);
  migrateModelsV21Whisper(db);
  migrateModelsV22NewProviders(db);
  migrateModelsV23FixProviders(db);
  migrateModelsV24DeadCleanup(db);
  migrateModelsV25CfImg2ImgDeprecated(db);
  migrateModelsV26RebalancePriorities(db);
  migrateModelsV27PollinationsImg2Img(db);
  migrateModelsV28CfFlux2(db);
  migrateRequestsV29ModalityBackfill(db);
  migrateModelsV30EmbeddingCatalog(db);
  migrateBatches(db);
  // V31 ALTERs batch_items, so it must run AFTER migrateBatches creates the table.
  migrateBatchItemsV31Endpoint(db);
  migrateModelsV32CodestralAndTTS(db);
  migrateModelsV33CatalogExpansion(db);
  migrateModelsV34RerankCatalog(db);
  migrateKeyExpiryV35(db);
  migrateModelsV35NvidiaCatalog(db);
  migrateModelsV36NvidiaExpansion(db);
  migrateModelsV37DeadModelCleanup(db);
  migrateModelsV38QualityOrder(db);
  migrateModelsV39DeadNvidiaGithub(db);
  migrateModelsV40DisableDeepSeek(db);
  migrateModelsV41ImageCatalogCleanup(db);
  migrateModelsV42DreamshaperCleanup(db);
  migrateModelsV43DisableDeepSeekV4Pro(db);
  migrateModelsV47DisableSlowFreeTierModels(db);
  migrateModelsV52OpenRouterKimiK26(db);
  migrateModelsV53DemoteKimiK26CF(db);
  migrateUsageCounters(db);
  ensureUnifiedKey(db);
  // Per-project client API keys + per-key request attribution. ensureUnifiedKey
  // must run before V46 so the legacy unified_api_key value is available to
  // copy into the client_keys table.
  migrateClientKeysV44(db);
  migrateRequestsV45ClientKeyId(db);
  migrateClientKeysV46SeedGeneral(db);
  migrateClientKeysV48RenameGeneralToDefault(db);
  migrateClientKeysV49Reveal(db);
  migrateClientKeysV50SoftDelete(db);
  migrateClientKeysV51BackfillOrphans(db);
  migrateRequestsV54EndUser(db);
  migrateModelsV55Pricing(db);
  migrateEndUserLimitsV56(db);
  migratePricingV58FlashLiteDefault(db);
  migrateModelsV59KiloGemma4(db);
  // Must run LAST: re-sorts the fallback chain with the V57 balanced score,
  // reading measured health/latency that the requests table now carries.
  migrateModelsV57BalancedRerank(db);

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
  `);
}

function seedModels(db: Database.Database) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (count.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // NOTE: Limits current as of April 2026. See migrateModels() for in-place updates.
  const models = [
    // Google — gemini-2.5-flash free quotas were cut Dec 2025 (now ~20 RPD, budget much lower than before)
    ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1, 8, 'Frontier', 5, 100, 250000, null, '~12M', 1048576],
    ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 8, 3, 'Medium', 15, 1000, 250000, null, '~120M', 1048576],
    // OpenRouter — upgraded DeepSeek R1 -> V3.1 (stronger reasoning); default RPD ~200
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    // Cerebras — same 30 RPM / 1M TPD free pool; adding frontier coder, Llama 4 Maverick, GPT-OSS
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'qwen3-235b', 'Qwen3 235B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 8192],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    // GitHub Models — GPT-4o replaced with GPT-5 (same free tier key)
    ['github', 'openai/gpt-5', 'GPT-5 (GitHub)', 1, 7, 'Frontier', 10, 50, null, null, '~18M', 128000],
    // SambaNova — 70B RPM bumped to 20
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 6, 9, 'Large', 20, null, null, 200000, '~6M', 8192],
    // Mistral — Experiment pool ~1B tokens/mo shared across all models
    ['mistral', 'mistral-large-latest', 'Mistral Large 3', 7, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    // Groq — scout TPM corrected to 6k (not 30k)
    ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9, 2, 'Medium', 30, 1000, 6000, 500000, '~15M', 131072],
    ['groq', 'llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 10, 2, 'Medium', 30, 1000, 6000, 1000000, '~30M', 131072],
    // NVIDIA NIM — moved to credit-based model in 2025; no longer truly recurring monthly. Disabled by default.
    ['nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NV)', 11, 6, 'Large', 40, null, null, null, 'credits-based', 131072],
    // Cohere — trial tier is 1000 calls/mo total → realistic budget 1-2M
    ['cohere', 'command-r-plus-08-2024', 'Command R+ (08-2024)', 12, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cloudflare', '@cf/meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (CF)', 13, 11, 'Medium', null, null, null, null, '~18-45M', 131072],
    // Hugging Face — free Inference credits are ~$0.10/mo → budget closer to 1-3M on a 70B model
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14, 11, 'Medium', null, null, null, null, '~1-3M', 131072],
    // New providers — recurring monthly free tiers, no card required
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  const insertMany = db.transaction(() => {
    for (const m of models) {
      insert.run(...m);
    }
  });
  insertMany();

  // Seed default fallback config from models
  const allModels = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as { id: number; intelligence_rank: number }[];
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  const insertFallbacks = db.transaction(() => {
    for (let i = 0; i < allModels.length; i++) {
      insertFallback.run(allModels[i].id, i + 1);
    }
  });
  insertFallbacks();

  console.log(`Seeded ${models.length} models and fallback config`);
}

/**
 * Idempotent migration to bring existing DBs up to the April 2026 pool.
 * Covers: replaces outdated models (DeepSeek R1 → V3.1, GPT-4o → GPT-5),
 * corrects stale rate-limits / monthly budgets, adds new smarter models
 * and three new providers (Zhipu, Moonshot, MiniMax).
 */
function migrateModels(db: Database.Database) {
  // 1) Replace outdated models in-place (preserves fallback_config & any references)
  const renames: Array<[string, string, string, string, number, string, number | null, number | null, number]> = [
    // platform, oldModelId, newModelId, newDisplayName, intelligenceRank, monthlyBudget, rpdLimit, contextWindow, sizeLabelPriority(unused)
  ];
  const renameStmt = db.prepare(`
    UPDATE models
       SET model_id = ?, display_name = ?, intelligence_rank = ?,
           monthly_token_budget = ?, rpd_limit = COALESCE(?, rpd_limit),
           context_window = COALESCE(?, context_window),
           size_label = COALESCE(?, size_label)
     WHERE platform = ? AND model_id = ?
  `);
  // DeepSeek R1 (free) -> DeepSeek V3.1 (free)
  renameStmt.run('deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, '~6M', 200, 131072, 'Frontier', 'openrouter', 'deepseek/deepseek-r1:free');
  // GitHub GPT-4o -> GPT-5
  renameStmt.run('openai/gpt-5', 'GPT-5 (GitHub)', 1, '~18M', null, 128000, 'Frontier', 'github', 'gpt-4o');

  // 2) Correct stale limits / budgets on existing rows
  db.prepare(`UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
  db.prepare(`UPDATE models SET rpm_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
  db.prepare(`UPDATE models SET tpm_limit = 6000 WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'`).run();
  db.prepare(`UPDATE models SET monthly_token_budget = '~1-2M' WHERE platform = 'cohere' AND model_id = 'command-r-plus-08-2024'`).run();
  db.prepare(`UPDATE models SET monthly_token_budget = '~1-3M' WHERE platform = 'huggingface' AND model_id = 'accounts/fireworks/models/llama-v3p3-70b-instruct'`).run();
  // NVIDIA moved to credit model — disable and label accordingly
  db.prepare(`UPDATE models SET monthly_token_budget = 'credits-based', enabled = 0 WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'`).run();

  // 3) Insert new models (UNIQUE(platform, model_id) makes this idempotent)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const newModels: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // Cerebras — same free pool as qwen3-235b
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    // OpenRouter free tier
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    // Mistral Experiment pool — shared ~1B/mo across models
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    // New providers
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  const apply = db.transaction(() => {
    for (const m of newModels) insert.run(...m);

    // Ensure every model has a fallback_config row (new inserts + any orphans)
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) {
        addFallback.run(missing[i].id, maxPriority + i + 1);
      }
    }
  });
  apply();
}

/**
 * Second-pass migration after live-testing every model against its provider.
 * Corrects model IDs verified wrong, removes models not actually available on
 * the current free tier, and adds real :free OpenRouter models found in the
 * live catalog (April 2026).
 */
function migrateModelsV2(db: Database.Database) {
  // Helper: delete a model and its fallback_config entry (FK is RESTRICT-by-default)
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    // GitHub free tier does NOT include GPT-5 (only catalog-listed). Revert handled below.
    // Cerebras: qwen-3-coder-480b and llama-4-maverick not on free tier; gpt-oss-120b is listed
    // but requires special access — our key gets 404. Remove all three.
    ['cerebras', 'qwen-3-coder-480b'],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct'],
    ['cerebras', 'gpt-oss-120b'],
    // These OpenRouter :free variants do not exist in the live catalog (April 2026)
    ['openrouter', 'deepseek/deepseek-v3.1:free'],
    ['openrouter', 'moonshotai/kimi-k2:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  // GitHub: gpt-5 is in the model catalog but returns "unavailable_model" on free tier
  // inference. Revert to gpt-4o which works. This only runs if the gpt-5 row exists.
  db.prepare(`
    UPDATE models
       SET model_id = 'gpt-4o', display_name = 'GPT-4o', intelligence_rank = 5,
           size_label = 'Large', context_window = 8000, monthly_token_budget = '~18M'
     WHERE platform = 'github' AND model_id = 'openai/gpt-5'
  `).run();

  // Groq: scout requires the meta-llama/ publisher prefix
  db.prepare(`
    UPDATE models SET model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'
     WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'
  `).run();

  // Add real OpenRouter :free models that exist in the live catalog
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // Frontier-tier free models verified in OR catalog 2026-04
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'minimax/minimax-m2.5:free', 'MiniMax M2.5 (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 196608],
    ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 5, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
  ];
  const applyAdditions = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    // Fallback entries for new models
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  applyAdditions();
}

/**
 * Re-rank intelligence based on April 2026 coding + agentic tool-use benchmarks:
 * SWE-bench Verified, Terminal-Bench 2, TAU-Bench, Aider Polyglot.
 * Higher rank = weaker. Ties are allowed (same weights across providers).
 */
function migrateModelsV3Ranks(db: Database.Database) {
  const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
  const ranks: Array<[number, string, string]> = [
    // #1-10 frontier coders / agents
    [1,  'openrouter',  'minimax/minimax-m2.5:free'],                     // SWE-V ~80%, TB2 ~57%
    [2,  'openrouter',  'qwen/qwen3-coder:free'],                         // SWE-V ~70%
    [3,  'openrouter',  'qwen/qwen3-next-80b-a3b-instruct:free'],         // SWE-V ~70.6%
    [4,  'moonshot',    'kimi-latest'],                                   // K2: SWE-V ~71%
    [5,  'cerebras',    'qwen-3-235b-a22b-instruct-2507'],                // SWE-V ~65-72%
    [6,  'google',      'gemini-2.5-pro'],                                // SWE-V 63.8%, Aider 83%
    [7,  'openrouter',  'z-ai/glm-4.5-air:free'],                         // ~58% SWE-V (distill of 4.5)
    [8,  'openrouter',  'openai/gpt-oss-120b:free'],                      // SWE-V 62.4%
    [9,  'openrouter',  'nvidia/nemotron-3-super-120b-a12b:free'],        // SWE-V 53.7%
    [10, 'minimax',     'MiniMax-M1'],                                    // M1 predecessor, ~45-55%
    // #11-15 mid-tier specialists
    [11, 'mistral',     'codestral-latest'],                              // HumanEval 86.6%
    [12, 'mistral',     'mistral-large-latest'],
    [13, 'mistral',     'magistral-medium-latest'],                       // reasoning, not code-tuned
    [14, 'google',      'gemini-2.5-flash'],
    [15, 'zhipu',       'glm-4.5-flash'],
    // #16 Llama 3.3 70B — identical weights across providers (tie)
    [16, 'groq',        'llama-3.3-70b-versatile'],
    [16, 'sambanova',   'Meta-Llama-3.3-70B-Instruct'],
    [16, 'openrouter',  'meta-llama/llama-3.3-70b-instruct:free'],
    [16, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    // #17-23 weaker
    [17, 'openrouter',  'nousresearch/hermes-3-llama-3.1-405b:free'],     // L3.1 base with tool-use tune
    [18, 'groq',        'meta-llama/llama-4-scout-17b-16e-instruct'],     // multimodal focus
    [19, 'openrouter',  'google/gemma-4-31b-it:free'],
    [20, 'google',      'gemini-2.5-flash-lite'],
    [21, 'github',      'gpt-4o'],                                        // Aug 2024, SWE-V ~33%
    [22, 'nvidia',      'meta/llama-3.1-70b-instruct'],                   // older Llama 3.1 tune
    [22, 'cloudflare',  '@cf/meta/llama-3.1-70b-instruct'],               // same base weights
    [23, 'cohere',      'command-r-plus-08-2024'],                        // RAG-focused, weakest on code
  ];
  const apply = db.transaction(() => {
    for (const [rank, platform, modelId] of ranks) {
      setRank.run(rank, platform, modelId);
    }
  });
  apply();
}

/**
 * V4: Agentic-tool-use focus. Live-probed every candidate against real free-tier
 * keys (April 2026) with a weather-tool function-calling test. Keeps only models
 * that return a structured tool_calls response and are reachable on the free tier.
 *
 * Adds SambaNova DeepSeek/Llama-4/gpt-oss, Groq gpt-oss & qwen3-32b, OpenRouter
 * ling-2.6-flash + nemotron-nano + gpt-oss + trinity, Mistral devstral/medium,
 * GitHub gpt-4.1, Cohere command-a, Cloudflare llama-4/gpt-oss/glm-4.7. Removes
 * moonshot/kimi (paid-only now), minimax/M1 (superseded), HF/Fireworks route
 * (no structured tools), OR/gemma-4 (weak at tools). Renames CF llama-3.1 → 3.3
 * fp8-fast. Corrects stale limits.
 */
function migrateModelsV4(db: Database.Database) {
  // 1) Remove entries that are unavailable or fail agentic tool use
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['moonshot', 'kimi-latest'],                                            // paid-only now ($1 min deposit)
    ['minimax', 'MiniMax-M1'],                                              // superseded; use OR minimax-m2.5:free
    ['openrouter', 'google/gemma-4-31b-it:free'],                           // weak at tool use
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],  // emits tool call as text content, not structured
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  // 2) Cloudflare: replace Llama 3.1 70B with the current-gen 3.3 70B fp8-fast
  db.prepare(`
    UPDATE models
       SET model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
           display_name = 'Llama 3.3 70B fp8-fast (CF)',
           context_window = 131072
     WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.1-70b-instruct'
  `).run();

  // 3) Field corrections verified via primary sources + live probe
  db.prepare(`UPDATE models SET tpm_limit = 12000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 14400 WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 250, monthly_token_budget = '~25M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
  // gemini-2.5-pro is at-risk: April 2026 Google moved Pro-class off free tier in practice.
  // Our live probe hit "quota exceeded" immediately. Cut rpd in half to reduce 429 blast radius.
  db.prepare(`UPDATE models SET rpd_limit = 50, monthly_token_budget = '~6M' WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();

  // 4) Add live-probed, tool-capable models
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // OpenRouter :free — shared 20 RPM / 200 RPD / ~6M tokens across :free pool
    ['openrouter', 'inclusionai/ling-2.6-flash:free',        'Ling 2.6 Flash (free)',         7,  9,  'Large',    20, 200, null, null, '~6M', 262144],
    ['openrouter', 'arcee-ai/trinity-large-preview:free',    'Trinity Large Preview (free)',  13, 9,  'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free',    'Nemotron 3 Nano 30B (free)',    22, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'openai/gpt-oss-120b:free',               'GPT-OSS 120B (free)',           6,  9,  'Large',    20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openai/gpt-oss-20b:free',                'GPT-OSS 20B (free)',            18, 9,  'Medium',   20, 200, null, null, '~6M', 131072],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)',          17, 9,  'Medium',   20, 200, null, null, '~6M', 131072],

    // SambaNova — 20 RPM / 20 RPD / 200K TPD shared free Developer tier
    ['sambanova',  'DeepSeek-V3.1',                          'DeepSeek V3.1',                 5,  9,  'Frontier', 20, 20,  null, 200000, '~3M', 131072],
    ['sambanova',  'DeepSeek-V3.2',                          'DeepSeek V3.2',                 4,  9,  'Frontier', 20, 20,  null, 200000, '~3M', 131072],
    ['sambanova',  'Llama-4-Maverick-17B-128E-Instruct',     'Llama 4 Maverick',              11, 9,  'Large',    20, 20,  null, 200000, '~3M', 8192],
    ['sambanova',  'gpt-oss-120b',                           'GPT-OSS 120B (SambaNova)',      6,  9,  'Large',    20, 20,  null, 200000, '~3M', 131072],

    // Groq — very fast; 30 RPM per model, 1000 RPD on most, 14.4k on the 8B
    ['groq',       'openai/gpt-oss-120b',                    'GPT-OSS 120B (Groq)',           6,  2,  'Large',    30, 1000, 8000, 200000,  '~6M',  131072],
    ['groq',       'openai/gpt-oss-20b',                     'GPT-OSS 20B (Groq)',            18, 2,  'Medium',   30, 1000, 8000, 200000,  '~6M',  131072],
    ['groq',       'qwen/qwen3-32b',                         'Qwen3 32B (Groq)',              19, 2,  'Medium',   60, 1000, 6000, 500000,  '~15M', 131072],
    ['groq',       'llama-3.1-8b-instant',                   'Llama 3.1 8B Instant',          28, 2,  'Small',    30, 14400, 6000, 500000, '~15M', 131072],

    // Mistral Experiment tier — shared 2 RPM / 500k TPM / 1B tokens/mo across all models
    ['mistral',    'devstral-latest',                        'Devstral',                      16, 8,  'Medium',   2, null, 500000, null, '~50-100M', 131072],
    ['mistral',    'mistral-medium-latest',                  'Mistral Medium 3.5',            14, 8,  'Large',    2, null, 500000, null, '~50-100M', 131072],

    // GitHub Models — Low-tier category (15 RPM / 150 RPD, 8K in / 4K out per call)
    ['github',     'openai/gpt-4.1',                         'GPT-4.1 (GitHub)',              20, 7,  'Large',    10, 50,  null, null, '~9M', 128000],

    // Cohere — shared 1000 calls/mo trial pool, 20 RPM Chat
    ['cohere',     'command-a-03-2025',                      'Command-A (03-2025)',           27, 11, 'Large',    20, 33,  null, null, '~1-2M', 131072],

    // Cloudflare Workers AI — shared 10K Neurons/day free pool across all @cf/* models
    ['cloudflare', '@cf/openai/gpt-oss-120b',                'GPT-OSS 120B (CF)',             6,  11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/zai-org/glm-4.7-flash',              'GLM-4.7 Flash (CF)',            10, 11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)',            12, 11, 'Large',    null, null, null, null, '~18-45M', 131072],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();

  // 5) Re-rank the live catalog by agentic tool-use capability (lower = smarter).
  //    Grounded in April 2026 SWE-Bench Verified + BFCL v3 + Tau-Bench numbers.
  const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
  const ranks: Array<[number, string, string]> = [
    [1,  'openrouter',  'minimax/minimax-m2.5:free'],
    [2,  'openrouter',  'qwen/qwen3-coder:free'],
    [3,  'openrouter',  'qwen/qwen3-next-80b-a3b-instruct:free'],
    [4,  'sambanova',   'DeepSeek-V3.2'],
    [5,  'sambanova',   'DeepSeek-V3.1'],
    [6,  'cerebras',    'qwen-3-235b-a22b-instruct-2507'],
    [6,  'openrouter',  'openai/gpt-oss-120b:free'],
    [6,  'groq',        'openai/gpt-oss-120b'],
    [6,  'sambanova',   'gpt-oss-120b'],
    [6,  'cloudflare',  '@cf/openai/gpt-oss-120b'],
    [7,  'openrouter',  'inclusionai/ling-2.6-flash:free'],
    [8,  'openrouter',  'z-ai/glm-4.5-air:free'],
    [10, 'cloudflare',  '@cf/zai-org/glm-4.7-flash'],
    [11, 'sambanova',   'Llama-4-Maverick-17B-128E-Instruct'],
    [12, 'groq',        'meta-llama/llama-4-scout-17b-16e-instruct'],
    [12, 'cloudflare',  '@cf/meta/llama-4-scout-17b-16e-instruct'],
    [13, 'openrouter',  'arcee-ai/trinity-large-preview:free'],
    [14, 'google',      'gemini-2.5-pro'],
    [14, 'mistral',     'mistral-large-latest'],
    [14, 'mistral',     'mistral-medium-latest'],
    [16, 'mistral',     'devstral-latest'],
    [16, 'mistral',     'codestral-latest'],
    [17, 'groq',        'llama-3.3-70b-versatile'],
    [17, 'sambanova',   'Meta-Llama-3.3-70B-Instruct'],
    [17, 'cloudflare',  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    [17, 'openrouter',  'meta-llama/llama-3.3-70b-instruct:free'],
    [17, 'nvidia',      'meta/llama-3.1-70b-instruct'],
    [18, 'openrouter',  'openai/gpt-oss-20b:free'],
    [18, 'groq',        'openai/gpt-oss-20b'],
    [19, 'groq',        'qwen/qwen3-32b'],
    [20, 'google',      'gemini-2.5-flash'],
    [20, 'github',      'openai/gpt-4.1'],
    [21, 'mistral',     'magistral-medium-latest'],
    [22, 'openrouter',  'nvidia/nemotron-3-super-120b-a12b:free'],
    [23, 'openrouter',  'nvidia/nemotron-3-nano-30b-a3b:free'],
    [24, 'zhipu',       'glm-4.5-flash'],
    [25, 'github',      'gpt-4o'],
    [26, 'google',      'gemini-2.5-flash-lite'],
    [27, 'cohere',      'command-a-03-2025'],
    [27, 'cohere',      'command-r-plus-08-2024'],
    [28, 'groq',        'llama-3.1-8b-instant'],
  ];
  const applyRanks = db.transaction(() => {
    for (const [r, p, m] of ranks) setRank.run(r, p, m);
  });
  applyRanks();
}

/**
 * V5: Google moved all Pro-tier Gemini off the free tier on 2026-04-01 — disable
 * gemini-2.5-pro. Add Cerebras `zai-glm-4.7` (355B z.ai GLM preview, newly on
 * free tier but throttled to 10 RPM / 100 RPD due to high demand; context capped
 * at 8192 on free tier).
 */
function migrateModelsV5(db: Database.Database) {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const apply = db.transaction(() => {
    insert.run('cerebras', 'zai-glm-4.7', 'GLM-4.7 (Cerebras)', 7, 1, 'Frontier', 10, 100, null, null, '~3M', 8192);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V6: Live-probed against real free-tier keys on 2026-04-25.
 *
 * Corrections (Google free-tier RPD): the documented "250" / "1000" RPD numbers
 * for gemini-2.5-flash and gemini-2.5-flash-lite are stale — both share a 20
 * RPD per-model-per-project free pool now. Confirmed by the
 * `generate_content_free_tier_requests` quota error, limit 20.
 *
 * Removals: arcee-ai/trinity-large-preview:free returns 404 "No endpoints found"
 * — pulled from OpenRouter's free pool. (Other previously-suspected dead OR :free
 * IDs are still live in /api/v1/models, so they stay.)
 *
 * Additions (all probe-verified to return 200 with content on the user's keys):
 *   - 3 Cloudflare Workers AI reasoning models
 *   - 3 Google preview models, including Pro (which returned a free-tier 429
 *     against the same 20 RPD pool, confirming free-tier eligibility)
 *   - 2 OpenRouter :free models with no expiration_date
 */
function migrateModelsV6(db: Database.Database) {
  // 1) Remove confirmed-dead OR route
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['openrouter', 'arcee-ai/trinity-large-preview:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  // 2) Correct stale Google free-tier RPD numbers
  db.prepare(`
    UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M'
     WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
  `).run();
  db.prepare(`
    UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M'
     WHERE platform = 'google' AND model_id = 'gemini-2.5-flash-lite'
  `).run();

  // 3) Add live-probed models
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // Cloudflare Workers AI — 10K Neurons/day shared free pool. Reasoning traces
    // burn output tokens fast, so per-call effective budget is small. Estimates
    // assume 1K-in/500-out typical: kimi-k2.5 ≈ 50/day, qwen3-30b ≈ 200/day,
    // r1-distill ≈ 5/day on the reasoning-heavy path.
    ['cloudflare', '@cf/moonshotai/kimi-k2.5',                    'Kimi K2.5 (CF)',                  3,  11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8',                  'Qwen3 30B-A3B fp8 (CF)',          7,  11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B (CF)', 9, 11, 'Large',  null, null, null, null, '~3-5M',   131072],

    // Google preview tier — shares the 20 RPD per-model free pool. Pro confirmed
    // free-tier-eligible by the `free_tier_requests` quota metric in 429 errors.
    ['google',     'gemini-3.1-flash-lite-preview',               'Gemini 3.1 Flash-Lite Preview',   18, 3,  'Medium',   15, 20,  250000, null, '~3M',  1048576],
    ['google',     'gemini-3-flash-preview',                       'Gemini 3 Flash Preview',          11, 5,  'Large',    10, 20,  250000, null, '~3M',  1048576],
    ['google',     'gemini-3.1-pro-preview',                       'Gemini 3.1 Pro Preview',          1,  8,  'Frontier',  5, 20,  250000, null, '~3M',  1048576],

    // OpenRouter :free pool — 20 RPM / 50 RPD (1000 once $10 credits bought).
    ['openrouter', 'google/gemma-4-31b-it:free',                   'Gemma 4 31B (free)',             19, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free',            'Liquid LFM 2.5 1.2B (free)',     30, 10, 'Small',    20, 200, null, null, '~6M', 32768],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V7 (April 2026): live-probed delta against OpenRouter's free pool + Z.ai.
 * - Removes inclusionai/ling-2.6-flash:free (transitioned to paid, 404 on chat).
 * - Adds 8 new :free routes confirmed via /v1/models + chat-completion probe.
 * - Adds zhipu/glm-4.7-flash (probe: 429 "overloaded" — free-pool throttle, not
 *   "insufficient balance" which paid models return). Same baseUrl works for both
 *   api.z.ai and open.bigmodel.cn keys.
 * HF and NVIDIA left as-is: HF still serves chat with current key; NVIDIA already disabled.
 */
function migrateModelsV7(db: Database.Database) {
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['openrouter', 'inclusionai/ling-2.6-flash:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // OpenRouter :free quotas: 20 RPM / 50 RPD without credits, 1000 RPD with $10 lifetime topup.
  // Catalog convention is rpd=200 (matches existing rows).
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    ['openrouter', 'inclusionai/ling-2.6-1t:free',                           'Ling 2.6 1T (free)',                       4,  9,  'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'tencent/hy3-preview:free',                               'Tencent HY3 Preview (free)',               7,  9,  'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-m.1:free',                               'Poolside Laguna M.1 (free)',               13, 9,  'Large',    20, 200, null, null, '~6M', 131072],
    ['openrouter', 'google/gemma-4-26b-a4b-it:free',                         'Gemma 4 26B-A4B (free)',                   22, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',     'Nemotron 3 Nano 30B Reasoning (free)',     23, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-xs.2:free',                              'Poolside Laguna XS.2 (free)',              26, 10, 'Medium',   20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-nano-9b-v2:free',                        'Nemotron Nano 9B v2 (free)',               28, 10, 'Medium',   20, 200, null, null, '~6M', 128000],
    ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free',                      'Liquid LFM 2.5 1.2B Thinking (free)',      30, 10, 'Small',    20, 200, null, null, '~6M', 32768],
    // Zhipu (Z.ai) — free pool. glm-4.7-flash quotas unpublished; mirror glm-4.5-flash row shape.
    ['zhipu',      'glm-4.7-flash',                                          'GLM-4.7 Flash',                            18, 4,  'Large',    null, null, null, 1000000, '~30M', 131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V8 (May 2026): 3-day delta. SambaNova's /v1/models added two free-tier models;
 * Cloudflare's @cf catalog added two new text models. All four probe-verified 200
 * with the user's keys. SambaNova's paid-only MiniMax-M2.5 explicitly returns 422
 * "Couldn't find valid service tier", so the 200s on these rows confirm free-tier
 * access. Cloudflare's @cf/* models share the 10K Neurons/day free pool.
 */
function migrateModelsV8(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // SambaNova free pool: 20 RPM / 20 RPD / 200K TPD shared across all free models.
    ['sambanova',  'DeepSeek-V3.1-cb',                          'DeepSeek V3.1 (CB)',             5,  9,  'Frontier', 20, 20, null, 200000, '~3M',     131072],
    ['sambanova',  'gemma-3-12b-it',                            'Gemma 3 12B (SambaNova)',        22, 9,  'Medium',   20, 20, null, 200000, '~3M',     131072],
    // Cloudflare @cf — 10K Neurons/day shared pool.
    ['cloudflare', '@cf/moonshotai/kimi-k2.6',                  'Kimi K2.6 (CF)',                 2,  11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro',       'Granite 4.0 H Micro (CF)',       29, 11, 'Small',    null, null, null, null, '~5-10M',  131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V9 (May 2026): disable cerebras/zai-glm-4.7. The model still appears in
 * Cerebras's /v1/models listing but the chat-completions endpoint returns
 * 404 "Model does not exist or you do not have access" for free-tier keys —
 * matches their docs note about temporarily reducing free-tier access on
 * zai-glm-4.7 due to high demand. Row kept (not deleted) so it can be
 * re-enabled later without losing fallback_config history.
 */
function migrateModelsV9(db: Database.Database) {
  db.prepare(
    "UPDATE models SET enabled = 0 WHERE platform = 'cerebras' AND model_id = 'zai-glm-4.7'"
  ).run();
}

/**
 * V10 (May 2026): Ollama Cloud — first new platform since Z.ai/Zhipu in V7.
 * Free plan: GPU-time-based quota (not per-token), 1 concurrent model,
 * 5h session caps, no card required. /v1/models lists 39 SKUs but only 28
 * respond on the Free tier — paid models return 403 with an explicit
 * "this model requires a subscription" message.
 *
 * Curated to ~10 representative free models that either (a) aren't reachable
 * elsewhere in the catalog or (b) provide a useful alternate route through
 * Ollama's independent rate-limit pool. Probe-verified May 2 2026.
 *
 * Quota shape: GPU-time, not tokens. monthly_token_budget reflects rough
 * Free-tier "session" capacity rather than a hard token cap.
 */
function migrateModelsV10(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // Budget strings are estimates: Ollama publishes no token cap (quota is GPU-time +
    // 7-day rolling). Frontier ~5-10M, Large ~10-20M, Medium ~20-30M reflect that
    // heavier models burn quota faster. Numeric limits stay null — real provider
    // throttling is the source of truth, not these display strings.
    ['ollama', 'qwen3-coder:480b',     'Qwen3-Coder 480B (Ollama)',    2,  9, 'Frontier', null, null, null, null, '~5-10M',  262144],
    ['ollama', 'mistral-large-3:675b', 'Mistral Large 3 675B (Ollama)', 3,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'deepseek-v3.2',        'DeepSeek V3.2 (Ollama)',        4,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'cogito-2.1:671b',      'Cogito 2.1 671B (Ollama)',      4,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'kimi-k2-thinking',     'Kimi K2 Thinking (Ollama)',     5,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'glm-4.7',              'GLM-4.7 (Ollama)',              6,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'gpt-oss:120b',         'GPT-OSS 120B (Ollama)',         6,  9, 'Large',    null, null, null, null, '~10-20M', 131072],
    ['ollama', 'devstral-2:123b',      'Devstral 2 123B (Ollama)',      8, 10, 'Large',    null, null, null, null, '~10-20M', 131072],
    ['ollama', 'gpt-oss:20b',          'GPT-OSS 20B (Ollama)',         18, 10, 'Medium',   null, null, null, null, '~20-30M', 131072],
    ['ollama', 'gemma4:31b',           'Gemma 4 31B (Ollama)',         22, 10, 'Medium',   null, null, null, null, '~20-30M', 131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * Faz 1 Batch API tables. Idempotent (CREATE TABLE IF NOT EXISTS).
 * On boot, any stale 'inflight' items from a prior crash are reset to 'pending'
 * so the worker can pick them up again.
 */
function migrateBatches(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id                TEXT PRIMARY KEY,
      status            TEXT NOT NULL,
      total             INTEGER NOT NULL,
      completed         INTEGER NOT NULL DEFAULT 0,
      failed            INTEGER NOT NULL DEFAULT 0,
      priority          INTEGER NOT NULL DEFAULT 2,
      metadata          TEXT,
      callback_url      TEXT,
      callback_status   TEXT,
      callback_attempts INTEGER NOT NULL DEFAULT 0,
      idempotency_key   TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      started_at        TEXT,
      finished_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status, priority DESC, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_idem ON batches(idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS batch_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      position        INTEGER NOT NULL,
      custom_id       TEXT NOT NULL,
      request_body    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      response_body   TEXT,
      error_message   TEXT,
      routed_platform TEXT,
      routed_model    TEXT,
      latency_ms      INTEGER,
      attempt         INTEGER NOT NULL DEFAULT 0,
      processed_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_items_pending ON batch_items(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_items_global_pending ON batch_items(status, batch_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_batch_custom ON batch_items(batch_id, custom_id);
  `);

  // Crash recovery: any item left as 'inflight' from a prior process death
  // gets requeued. attempt counter remains so the operator can observe.
  db.prepare("UPDATE batch_items SET status='pending' WHERE status='inflight'").run();
}

/**
 * V11: Vision (multimodal image input) flag. Adds models.vision_capable column
 * and flips known-vision models on. Live-probe verified May 2026.
 *
 * Flagged via OpenAI standard `content: [{type:'text'},{type:'image_url'}]`.
 * Provider-side translation:
 *   - openai-compat (Groq/SambaNova/Cerebras/OR/Cloudflare/Mistral): passthrough
 *   - google: image_url → inline_data parts (base64 fetch for http URLs)
 */
function migrateModelsV11Vision(db: Database.Database) {
  // ALTER ... ADD COLUMN is idempotent guarded by try/catch (SQLite errors on duplicate).
  try {
    db.exec(`ALTER TABLE models ADD COLUMN vision_capable INTEGER NOT NULL DEFAULT 0`);
  } catch (e: any) {
    if (!(e?.message ?? '').includes('duplicate column')) throw e;
  }

  const setVision = db.prepare(`UPDATE models SET vision_capable = 1 WHERE platform = ? AND model_id = ?`);
  const visionModels: Array<[string, string]> = [
    // Google Gemini — official multimodal
    ['google', 'gemini-2.5-flash'],
    ['google', 'gemini-2.5-flash-lite'],
    ['google', 'gemini-2.5-pro'],
    ['google', 'gemini-3-flash-preview'],
    ['google', 'gemini-3.1-flash-lite-preview'],
    ['google', 'gemini-3.1-pro-preview'],
    // Llama 4 family — native multimodal
    ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    ['sambanova', 'Llama-4-Maverick-17B-128E-Instruct'],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct'],
    // Kimi K2.5/K2.6 — multimodal
    ['cloudflare', '@cf/moonshotai/kimi-k2.5'],
    ['cloudflare', '@cf/moonshotai/kimi-k2.6'],
    // OpenRouter MiniMax M2.5 — multimodal
    ['openrouter', 'minimax/minimax-m2.5:free'],
  ];
  const apply = db.transaction(() => {
    for (const [p, m] of visionModels) setVision.run(p, m);
  });
  apply();
}

/**
 * V12: Structured-output flags.
 *  - supports_json_mode = 1 → model honours `response_format: {type:"json_object"}`
 *    (and json_schema where the provider supports it) without burning the
 *    token budget on a reasoning trace.
 *  - is_reasoning = 1 → model emits a thinking trace that consumes max_tokens
 *    and frequently truncates with content=null when the trace overflows.
 *    JSON-mode routing excludes these.
 *
 * Flags are seeded conservatively from provider docs + agent field reports.
 * Future probe sweeps can refine via UPDATEs.
 */
function migrateModelsV12JsonMode(db: Database.Database) {
  try {
    db.exec(`ALTER TABLE models ADD COLUMN supports_json_mode INTEGER NOT NULL DEFAULT 0`);
  } catch (e: any) {
    if (!(e?.message ?? '').includes('duplicate column')) throw e;
  }
  try {
    db.exec(`ALTER TABLE models ADD COLUMN is_reasoning INTEGER NOT NULL DEFAULT 0`);
  } catch (e: any) {
    if (!(e?.message ?? '').includes('duplicate column')) throw e;
  }

  const setJson = db.prepare(`UPDATE models SET supports_json_mode = 1 WHERE platform = ? AND model_id = ?`);
  const setReasoning = db.prepare(`UPDATE models SET is_reasoning = 1 WHERE platform = ? AND model_id = ?`);

  const jsonCapable: Array<[string, string]> = [
    // Google Gemini
    ['google', 'gemini-2.5-flash'],
    ['google', 'gemini-2.5-flash-lite'],
    ['google', 'gemini-2.5-pro'],
    ['google', 'gemini-3-flash-preview'],
    ['google', 'gemini-3.1-flash-lite-preview'],
    ['google', 'gemini-3.1-pro-preview'],
    // Groq
    ['groq', 'llama-3.3-70b-versatile'],
    ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    ['groq', 'openai/gpt-oss-120b'],
    ['groq', 'openai/gpt-oss-20b'],
    ['groq', 'qwen/qwen3-32b'],
    ['groq', 'llama-3.1-8b-instant'],
    // SambaNova
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct'],
    ['sambanova', 'Llama-4-Maverick-17B-128E-Instruct'],
    ['sambanova', 'gpt-oss-120b'],
    ['sambanova', 'DeepSeek-V3.1'],
    ['sambanova', 'DeepSeek-V3.2'],
    ['sambanova', 'DeepSeek-V3.1-cb'],
    ['sambanova', 'gemma-3-12b-it'],
    // Cerebras
    ['cerebras', 'qwen-3-235b-a22b-instruct-2507'],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct'],
    // Mistral
    ['mistral', 'mistral-large-latest'],
    ['mistral', 'mistral-medium-latest'],
    ['mistral', 'codestral-latest'],
    ['mistral', 'devstral-latest'],
    // OpenRouter free pool — non-reasoning
    ['openrouter', 'openai/gpt-oss-120b:free'],
    ['openrouter', 'openai/gpt-oss-20b:free'],
    ['openrouter', 'qwen/qwen3-coder:free'],
    ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free'],
    ['openrouter', 'minimax/minimax-m2.5:free'],
    ['openrouter', 'z-ai/glm-4.5-air:free'],
    ['openrouter', 'google/gemma-4-31b-it:free'],
    ['openrouter', 'tencent/hy3-preview:free'],
    ['openrouter', 'poolside/laguna-m.1:free'],
    ['openrouter', 'inclusionai/ling-2.6-1t:free'],
    // Cohere
    ['cohere', 'command-r-plus-08-2024'],
    ['cohere', 'command-a-03-2025'],
    // Cloudflare
    ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct'],
    ['cloudflare', '@cf/openai/gpt-oss-120b'],
    ['cloudflare', '@cf/zai-org/glm-4.7-flash'],
    ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8'],
    // Zhipu
    ['zhipu', 'glm-4.5-flash'],
    ['zhipu', 'glm-4.7-flash'],
    // GitHub
    ['github', 'gpt-4o'],
    ['github', 'openai/gpt-4.1'],
  ];

  const reasoning: Array<[string, string]> = [
    // Cloudflare reasoning trace (Kimi K2.x, R1 distill)
    ['cloudflare', '@cf/moonshotai/kimi-k2.5'],
    ['cloudflare', '@cf/moonshotai/kimi-k2.6'],
    ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'],
    // Mistral
    ['mistral', 'magistral-medium-latest'],
    // OpenRouter reasoning lineup
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free'],
    ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'],
    ['openrouter', 'nvidia/nemotron-nano-9b-v2:free'],
    ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free'],
    ['openrouter', 'poolside/laguna-xs.2:free'],
    // Ollama Cloud reasoning
    ['ollama', 'kimi-k2-thinking'],
    ['ollama', 'cogito-2.1:671b'],
  ];

  const apply = db.transaction(() => {
    for (const [p, m] of jsonCapable) setJson.run(p, m);
    for (const [p, m] of reasoning)   setReasoning.run(p, m);
  });
  apply();
}

/**
 * V13 (May 2026): production-log driven catalog corrections.
 *
 * Disable models pulled from free tier (OR `Ling-2.6-1T:free` and
 * `Hy3 preview:free` returned "no longer available as a free model"; OR
 * `nemotron-3-super-120b-a12b:free` was excluded for reasoning-only
 * behaviour already). Unflag MiniMax M2.5 vision: OR returns 404
 * "No endpoints found that support image input" for that route, so
 * vision_capable=1 is a false positive at the OR free-tier endpoint.
 *
 * Rows are not deleted so fallback_config history stays intact.
 */
function migrateModelsV13DeadModels(db: Database.Database) {
  const disable = db.prepare(`UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?`);
  const dead: Array<[string, string]> = [
    ['openrouter', 'inclusionai/ling-2.6-1t:free'],
    ['openrouter', 'tencent/hy3-preview:free'],
  ];
  const apply = db.transaction(() => {
    for (const [p, m] of dead) disable.run(p, m);
    db.prepare(`UPDATE models SET vision_capable = 0 WHERE platform = 'openrouter' AND model_id = 'minimax/minimax-m2.5:free'`).run();
  });
  apply();
}

/**
 * V14: diagnostic columns on requests so production failures surface their
 * own root cause without grepping pm2 logs.
 *
 *   error_class       — classifyError() bucket: rate_limit_day|rate_limit_minute
 *                       |rate_limit_unknown|invalid_key|provider_4xx|provider_5xx
 *                       |timeout|other. NULL for successes.
 *   upstream_status   — provider HTTP code extracted from the error string when
 *                       present (200/4xx/5xx). NULL when not parseable.
 *   attempts          — number of cascade attempts taken to reach this row's
 *                       outcome. 0 = first try. Aids "how deep did fallback go".
 *   has_image         — 1 if the request body carried any image_url part.
 *   response_format   — 'text'|'json_object'|'json_schema'|NULL.
 *   key_id            — which api_keys row served (or last tried) this request.
 *   request_id        — request-scoped ULID; lets one request's cascade rows
 *                       group together when N retries each get a row.
 */
function migrateRequestsV14Diagnostics(db: Database.Database) {
  const cols: Array<[string, string]> = [
    ['error_class',     'TEXT'],
    ['upstream_status', 'INTEGER'],
    ['attempts',        'INTEGER NOT NULL DEFAULT 0'],
    ['has_image',       'INTEGER NOT NULL DEFAULT 0'],
    ['response_format', 'TEXT'],
    ['key_id',          'INTEGER'],
    ['request_id',      'TEXT'],
  ];
  for (const [name, type] of cols) {
    try {
      db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
    } catch (e: any) {
      if (!(e?.message ?? '').includes('duplicate column')) throw e;
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_error_class ON requests(error_class) WHERE error_class IS NOT NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_request_id ON requests(request_id);`);

  // V14.1: requests.modality so image-gen rows can be filtered separately
  // from chat-completion rows in dashboards and usage queries.
  try { db.exec(`ALTER TABLE requests ADD COLUMN modality TEXT NOT NULL DEFAULT 'text'`); }
  catch (e: any) { if (!(e?.message ?? '').includes('duplicate column')) throw e; }
}

/**
 * V15 (May 2026): image-generation modality. Adds models.modality column
 * (text | image_gen | embedding) and models.neurons_per_call for Cloudflare
 * Workers AI neuron-cost tracking. Seeds 5 Cloudflare image-gen rows on first
 * run. Existing text rows default to modality='text'.
 *
 * Free tier estimate: 9 CF keys × 10K neurons/day shared = ~90K neurons/day.
 * FLUX schnell ~80 neurons → ~1,100 images/day if all neurons spent on
 * image-gen; ~500 if 50/50 split with chat models.
 */
function migrateModelsV15ImageGen(db: Database.Database) {
  // 1) ALTER TABLE columns (idempotent)
  try { db.exec(`ALTER TABLE models ADD COLUMN modality TEXT NOT NULL DEFAULT 'text'`); }
  catch (e: any) { if (!(e?.message ?? '').includes('duplicate column')) throw e; }
  try { db.exec(`ALTER TABLE models ADD COLUMN neurons_per_call INTEGER`); }
  catch (e: any) { if (!(e?.message ?? '').includes('duplicate column')) throw e; }

  // 2) Seed CF image-gen rows (INSERT OR IGNORE — idempotent on re-run)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, neurons_per_call
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'image_gen', ?)
  `);
  const imageGenModels: Array<[string, string, string, number, number, string, number]> = [
    // [platform, model_id, display_name, intel_rank, speed_rank, size_label, neurons]
    ['cloudflare', '@cf/black-forest-labs/flux-1-schnell',                'FLUX.1 Schnell (CF)',          1, 3, 'Image', 80],
    ['cloudflare', '@cf/bytedance/stable-diffusion-xl-lightning',         'SDXL Lightning (CF)',          2, 4, 'Image', 100],
    ['cloudflare', '@cf/lykon/dreamshaper-8-lcm',                         'Dreamshaper 8 LCM (CF)',       3, 2, 'Image', 40],
    ['cloudflare', '@cf/stabilityai/stable-diffusion-xl-base-1.0',        'SDXL Base 1.0 (CF)',           4, 9, 'Image', 600],
    ['cloudflare', '@cf/runwayml/stable-diffusion-v1-5-inpainting',       'SD 1.5 Inpainting (CF)',       5, 6, 'Image', 80],
  ];

  const apply = db.transaction(() => {
    for (const [p, m, name, intel, speed, sz, neurons] of imageGenModels) {
      insert.run(p, m, name, intel, speed, sz, null, null, null, null, '~10-20M', null, neurons);
    }
    // Ensure fallback_config rows for new image-gen models
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V16 (May 2026): Pollinations.ai keyless image-gen rows. No api_keys entry
 * needed — the router synthesizes a placeholder key_id=0 for keyless
 * providers (provider.requiresApiKey=false).
 *
 * Soft RPM ~5 per source IP (Pollinations policy). rpm_limit=5 lets the
 * existing rate-limiter respect this without provider 429 ping-pong.
 */
function migrateModelsV16Pollinations(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, neurons_per_call
    ) VALUES (?, ?, ?, ?, ?, 'Image', 5, NULL, NULL, NULL, '~unlimited', NULL, 1, 'image_gen', NULL)
  `);
  // [platform, model_id, display_name, intelligence_rank, speed_rank]
  const rows: Array<[string, string, string, number, number]> = [
    ['pollinations', 'pollinations/flux',         'FLUX (Pollinations, keyless)',    1, 3],
    ['pollinations', 'pollinations/turbo',        'Turbo (Pollinations, keyless)',   3, 1],
    ['pollinations', 'pollinations/flux-realism', 'FLUX Realism (Pollinations)',     2, 6],
    ['pollinations', 'pollinations/flux-anime',   'FLUX Anime (Pollinations)',       4, 6],
  ];
  const apply = db.transaction(() => {
    for (const r of rows) insert.run(...r);
    // fallback_config rows for these — placed at the end of the chain so CF
    // models stay primary (Pollinations is the cascade safety net).
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform = 'pollinations'
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V19 (May 2026): Pollinations.ai extra free models. Same keyless provider,
 * 4 more model_id rows. Probe-verified May 2026: each works via
 * GET /prompt/...?model=<name>. Soft IP-rate limit shared with existing
 * Pollinations rows.
 */
function migrateModelsV19PollinationsExtras(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, neurons_per_call
    ) VALUES (?, ?, ?, ?, ?, 'Image', 5, NULL, NULL, NULL, '~unlimited', NULL, 1, 'image_gen', NULL)
  `);
  const rows: Array<[string, string, string, number, number]> = [
    ['pollinations', 'pollinations/flux-3d',     'FLUX 3D (Pollinations)',          5, 7],
    ['pollinations', 'pollinations/flux-pro',    'FLUX Pro (Pollinations)',         2, 7],
    ['pollinations', 'pollinations/gptimage',    'GPT Image (Pollinations)',        3, 5],
    ['pollinations', 'pollinations/midjourney',  'Midjourney-style (Pollinations)', 2, 8],
  ];
  const apply = db.transaction(() => {
    for (const r of rows) insert.run(...r);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform = 'pollinations'
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V20 (May 2026): Zhipu CogView image-gen rows. The existing zhipu api_keys
 * row (used for GLM-4.5/4.7 chat) is the same Bearer token, so no new key
 * is required. Free tier on bigmodel.cn includes ~200 cogview-3-flash
 * images/day under a credit bucket; rpm_limit=10 to respect their soft cap.
 */
function migrateModelsV20ZhipuCogView(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, neurons_per_call
    ) VALUES (?, ?, ?, ?, ?, 'Image', ?, ?, NULL, NULL, '~200/day', NULL, 1, 'image_gen', NULL)
  `);
  // [platform, model_id, display_name, intel_rank, speed_rank, rpm, rpd]
  const rows: Array<[string, string, string, number, number, number, number]> = [
    ['zhipu', 'cogview-3-flash', 'CogView-3 Flash (Zhipu)', 3, 3, 10, 200],
    ['zhipu', 'cogview-3-plus',  'CogView-3 Plus (Zhipu)',  2, 7, 5,  100],
    ['zhipu', 'cogview-3',       'CogView-3 (Zhipu)',       3, 6, 10, 200],
  ];
  const apply = db.transaction(() => {
    for (const r of rows) insert.run(...r);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform = 'zhipu' AND m.modality = 'image_gen'
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V21 (May 2026): audio modality. Adds Cloudflare Whisper-large-v3-turbo as
 * speech-to-text provider. New modality value 'audio_stt' filtered by the
 * /v1/audio/transcriptions endpoint.
 *
 * Same 10K Neurons/key/day CF free pool — STT competes with image-gen +
 * chat. Whisper turbo ~80-200 neurons per minute of audio.
 */
function migrateModelsV21Whisper(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, neurons_per_call
    ) VALUES (?, ?, ?, ?, ?, 'Audio', NULL, NULL, NULL, NULL, '~50/day', NULL, 1, 'audio_stt', ?)
  `);
  insert.run('cloudflare', '@cf/openai/whisper-large-v3-turbo', 'Whisper large-v3-turbo (CF)', 5, 3, 150);
  insert.run('cloudflare', '@cf/openai/whisper',                'Whisper (CF)',                7, 5, 200);

  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE f.id IS NULL AND m.modality = 'audio_stt'
  `).all() as { id: number }[];
  if (missing.length > 0) {
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
  }
}

/**
 * V22 (May 2026): three new chat providers — DeepSeek Direct, AI21 Studio,
 * Reka AI. All OpenAI-compatible. Adds 2 models per provider so the router
 * has real catalog rows to dispatch to.
 *
 *   DeepSeek: deepseek-chat (V3.2), deepseek-reasoner (R1-class reasoning)
 *   AI21:     jamba-1.5-large, jamba-1.5-mini
 *   Reka:     reka-flash-3, reka-core
 *
 * Intelligence ranks reflect April-2026 SWE-bench / agentic benchmarks
 * approximations; tweak in a follow-up if real-world routing prefers a
 * different ordering.
 */
function migrateModelsV22NewProviders(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?)
  `);
  // [platform, model_id, display_name, intel_rank, speed_rank, size_label,
  //  rpm, rpd, tpm, tpd, monthly_budget, context_window, json_mode, is_reasoning]
  const rows: Array<[string, string, string, number, number, string,
                     number | null, number | null, number | null, number | null,
                     string, number | null, number, number]> = [
    // DeepSeek Direct — 5M token credit per new account
    ['deepseek', 'deepseek-chat',     'DeepSeek V3.2 (Direct)',         4,  6, 'Frontier', 60, null, null, null, '~5M', 131072, 1, 0],
    ['deepseek', 'deepseek-reasoner', 'DeepSeek R1 (Direct, reasoning)', 5,  9, 'Frontier', 60, null, null, null, '~5M', 65536,  0, 1],
    // AI21 Studio Jamba
    ['ai21',     'jamba-large-1.6',   'Jamba 1.6 Large (AI21)',          12, 7, 'Large',    20, null, null, null, '~10M', 256000, 1, 0],
    ['ai21',     'jamba-mini-1.6',    'Jamba 1.6 Mini (AI21)',           20, 4, 'Medium',   30, null, null, null, '~30M', 256000, 1, 0],
    // Reka AI
    ['reka',     'reka-flash-3',      'Reka Flash 3 (Reka)',             15, 4, 'Large',    20, null, null, null, '~10M', 128000, 1, 0],
    ['reka',     'reka-core',         'Reka Core (Reka)',                10, 8, 'Large',    10, null, null, null, '~5M',  128000, 1, 0],
  ];
  const apply = db.transaction(() => {
    for (const r of rows) insert.run(...r);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform IN ('deepseek','ai21','reka')
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V23 (May 2026): fix AI21 + Reka catalog entries discovered incorrect after
 * live API probe.
 *
 * AI21: jamba-1.6 series retired; new models are jamba-mini-2-2026-01 and
 *       jamba-large-1.7-2025-07. Old rows disabled.
 * Reka: reka-core does not exist in Reka API (returns 404). Removed.
 *       Added reka-edge-2603 (vision-capable, text+image+video input).
 *       Fixed reka-flash-3 context_window to actual value (65536).
 */
function migrateModelsV23FixProviders(db: Database.Database) {
  db.transaction(() => {
    // Disable wrong AI21 entries
    db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'ai21' AND model_id IN ('jamba-large-1.6','jamba-mini-1.6')`).run();
    // Disable nonexistent Reka entry
    db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'reka' AND model_id = 'reka-core'`).run();
    // Fix reka-flash-3 context window
    db.prepare(`UPDATE models SET context_window = 65536 WHERE platform = 'reka' AND model_id = 'reka-flash-3'`).run();

    const insertText = db.prepare(`
      INSERT OR IGNORE INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
        enabled, modality, supports_json_mode, is_reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?)
    `);
    const insertVision = db.prepare(`
      INSERT OR IGNORE INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
        enabled, modality, supports_json_mode, is_reasoning, vision_capable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?, ?)
    `);

    // [platform, model_id, display_name, intel, speed, size, rpm, rpd, tpm, tpd, budget, ctx, json_mode, is_reasoning]
    insertText.run('ai21', 'jamba-large-1.7-2025-07', 'Jamba 1.7 Large (AI21)', 11, 6, 'Large',  20, null, null, null, '~10M', 256000, 1, 0);
    insertText.run('ai21', 'jamba-mini-2-2026-01',    'Jamba Mini 2 (AI21)',    19, 3, 'Medium', 30, null, null, null, '~30M', 256000, 1, 0);
    // [... + vision_capable]
    insertVision.run('reka', 'reka-edge-2603', 'Reka Edge 2603 (Reka)', 14, 2, 'Medium', 30, null, null, null, '~15M', 16384, 0, 0, 1);

    // Wire new enabled rows into fallback_config
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform IN ('ai21','reka') AND m.enabled = 1
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  })();
}

/**
 * V36 (May 2026): NVIDIA NIM catalog expansion + auto-route quality re-tune.
 *
 * V35 seeded 11 NVIDIA rows. Live /models probe shows 123 models. This
 * migration adds the rest of the high-value ones grouped by use case:
 *
 *   Frontier chat (priority -> top of cascade after Cerebras/Groq):
 *     qwen/qwen3-coder-480b-a35b-instruct   massive code-tuned MoE
 *     minimaxai/minimax-m2.7                frontier (newer than openrouter:free)
 *     moonshotai/kimi-k2.6                  frontier
 *     z-ai/glm-5.1                          Zhipu top via NVIDIA
 *     openai/gpt-oss-120b                   open OpenAI clone
 *     nvidia/nemotron-3-super-120b-a12b     strong reasoning-tuned
 *
 *   Specialty chat (medical/financial/creative — niche routing):
 *     writer/palmyra-med-70b-32k            medical
 *     writer/palmyra-fin-70b-32k            finance
 *     writer/palmyra-creative-122b          creative writing
 *
 *   Embeddings (5 top-quality alternatives to existing CF BGE pool):
 *     nvidia/nv-embedqa-mistral-7b-v2       top NIM QA embed (4K dim)
 *     baai/bge-m3                           multilingual via NVIDIA
 *     snowflake/arctic-embed-l              strong English
 *     nvidia/nv-embedcode-7b-v1             code-aware embed (unique!)
 *     nvidia/nv-embed-v1                    proven generalist
 *
 *   Code-dedicated:
 *     meta/codellama-70b
 *     deepseek-ai/deepseek-coder-6.7b-instruct
 *
 * NVIDIA limits: 40 RPM per key (free tier), 6-month key expiry.
 * No image-gen, no real audio (TTS/STT), no rerank on NVIDIA — those
 * stay on CF / Cohere / Pollinations.
 */
function migrateModelsV36NvidiaExpansion(db: Database.Database) {
  const insChat = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?)
  `);
  const insEmbed = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'embedding', 0, 0)
  `);
  // [platform, model_id, display_name, intel, speed, size, rpm, rpd, tpm, tpd, budget, ctx, json, reasoning]
  // Frontier chat
  insChat.run('nvidia','qwen/qwen3-coder-480b-a35b-instruct',  'Qwen3 Coder 480B (NVIDIA)',         3, 4, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','minimaxai/minimax-m2.7',               'MiniMax M2.7 (NVIDIA)',             3, 5, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','moonshotai/kimi-k2.6',                 'Kimi K2.6 (NVIDIA)',                4, 5, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','z-ai/glm-5.1',                         'GLM 5.1 (NVIDIA)',                  5, 6, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','openai/gpt-oss-120b',                  'GPT-OSS 120B (NVIDIA)',             6, 6, 'Large',    40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','nvidia/nemotron-3-super-120b-a12b',    'Nemotron-3 Super 120B (NVIDIA)',    5, 6, 'Large',    40, null, null, null, '~RPM-capped', 131072, 1, 0);
  // Specialty chat
  insChat.run('nvidia','writer/palmyra-med-70b-32k',           'Palmyra Med 70B (NVIDIA, medical)', 7, 6, 'Large',    40, null, null, null, '~RPM-capped', 32768,  1, 0);
  insChat.run('nvidia','writer/palmyra-fin-70b-32k',           'Palmyra Fin 70B (NVIDIA, finance)', 7, 6, 'Large',    40, null, null, null, '~RPM-capped', 32768,  1, 0);
  insChat.run('nvidia','writer/palmyra-creative-122b',         'Palmyra Creative 122B (NVIDIA)',    7, 6, 'Large',    40, null, null, null, '~RPM-capped', 32768,  1, 0);
  // Code-dedicated
  insChat.run('nvidia','meta/codellama-70b',                   'CodeLlama 70B (NVIDIA)',           12, 6, 'Large',    40, null, null, null, '~RPM-capped', 32768,  0, 0);
  insChat.run('nvidia','deepseek-ai/deepseek-coder-6.7b-instruct','DeepSeek Coder 6.7B (NVIDIA)',  18, 8, 'Small',    40, null, null, null, '~RPM-capped', 16384,  0, 0);
  // Embeddings
  insEmbed.run('nvidia','nvidia/nv-embedqa-mistral-7b-v2',     'NV-EmbedQA Mistral 7B v2',          8, 6, 'Embed',    40, null, null, null, '~RPM-capped', 32768);
  insEmbed.run('nvidia','baai/bge-m3',                          'BGE-M3 (NVIDIA, multilingual)',    11, 7, 'Embed',    40, null, null, null, '~RPM-capped', 8192);
  insEmbed.run('nvidia','snowflake/arctic-embed-l',             'Arctic Embed L (NVIDIA)',          14, 8, 'Embed',    40, null, null, null, '~RPM-capped', 8192);
  insEmbed.run('nvidia','nvidia/nv-embedcode-7b-v1',            'NV-EmbedCode 7B v1 (code-aware)',   9, 6, 'Embed',    40, null, null, null, '~RPM-capped', 32768);
  insEmbed.run('nvidia','nvidia/nv-embed-v1',                   'NV-Embed v1 (generalist)',         13, 7, 'Embed',    40, null, null, null, '~RPM-capped', 32768);

  // Wire any new enabled rows into fallback_config
  const apply = db.transaction(() => {
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.enabled=1 AND m.platform='nvidia'
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxP = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxP + i + 1);
    }
  });
  apply();
}

/**
 * V37 (May 2026): dead-model + bad-flag cleanup from a 12h prod error audit.
 *
 *  - groq openai/gpt-oss-120b + qwen/qwen3-32b: returned HTTP 400
 *    "Failed to validate/generate JSON" 183× combined. They claim
 *    supports_json_mode=1 but reliably fail strict JSON requests, so the
 *    router kept picking them for EmlakCopilot's JSON traffic. Clearing the
 *    flag keeps them in the plain-text chain but out of JSON routing.
 *  - github gpt-4o / openai/o1-mini / openai/text-embedding-3-large:
 *    HTTP 403 "No access to model" — the GitHub Models account lost entitlement.
 *  - nvidia deepseek-ai/deepseek-coder-6.7b-instruct: HTTP 404 Not Found for
 *    this account; nvidia/llama-nemotron-embed-1b-v2: HTTP 400 Bad Request.
 *
 * Idempotent: plain UPDATEs scoped by platform+model_id.
 */
function migrateModelsV37DeadModelCleanup(db: Database.Database) {
  db.prepare(`
    UPDATE models SET supports_json_mode = 0
     WHERE platform = 'groq'
       AND model_id IN ('openai/gpt-oss-120b', 'qwen/qwen3-32b')
  `).run();
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'github'
       AND model_id IN ('gpt-4o', 'openai/o1-mini', 'openai/text-embedding-3-large')
  `).run();
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'nvidia'
       AND model_id IN ('deepseek-ai/deepseek-coder-6.7b-instruct',
                         'nvidia/llama-nemotron-embed-1b-v2')
  `).run();
}

/**
 * V42 (May 2026): disable Cloudflare Dreamshaper-8-LCM + clear poisoned key lock.
 *
 * Dreamshaper-8-LCM failed every call (0/9 today). Its error was being
 * classified as `invalid_key`, which key-wide-locked the ENTIRE Cloudflare
 * key — taking the healthy FLUX.2 / FLUX.1 image models down with it for an
 * hour. Two fixes ship together:
 *   - this migration disables the dead Dreamshaper row so it stops failing;
 *   - runImageGeneration/runImageEdit no longer key-wide-lock on
 *     `invalid_key` (image-gen treats it as a per-model deprecation signal).
 *
 * Also clears any stale cloudflare `invalid_key` cooldown row so the key
 * recovers immediately on deploy instead of waiting out the 1h lock.
 */
function migrateModelsV42DreamshaperCleanup(db: Database.Database) {
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'cloudflare' AND model_id = '@cf/lykon/dreamshaper-8-lcm'
  `).run();
  // The cooldowns table is created later by migrateUsageCounters; on a fresh
  // DB it does not exist yet (and has no poisoned row to clear anyway).
  const hasCooldowns = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cooldowns'"
  ).get();
  if (hasCooldowns) {
    db.prepare(`
      DELETE FROM cooldowns
       WHERE platform = 'cloudflare' AND reason = 'invalid_key'
    `).run();
  }
  applyQualityOrder(db);
}

/**
 * V43 (May 2026): disable deepseek-v4-pro on NVIDIA.
 *
 * The NVIDIA NIM endpoint for deepseek-ai/deepseek-v4-pro stalls for minutes
 * even on a 2-token prompt — 192/192 streaming requests aborted at the TTFB
 * timeout over a 3h window, and a direct probe 502'd at 91s. It was the top
 * model in the `coding` chain, so every Cline request hit it first and hung.
 * Disable until the upstream recovers; the chain self-heals (qwen3-coder-480b
 * becomes primary, Cerebras qwen-3-235b the fallback).
 */
function migrateModelsV43DisableDeepSeekV4Pro(db: Database.Database) {
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'nvidia' AND model_id = 'deepseek-ai/deepseek-v4-pro'
  `).run();
  applyQualityOrder(db);
}

/**
 * V47 (May 2026) — disable the rest of the NVIDIA NIM models that exhibit
 * the same TTFB-abort pattern as v4-pro under burst load.
 *
 * Stress-test data (20-parallel chat burst) showed:
 *  - nvidia/deepseek-v4-flash         — 90-180s aborts, attempts 1-2, then 502
 *  - nvidia/moonshotai/kimi-k2.6      — 90-135s aborts, attempts 2-3
 *  - groq/openai/gpt-oss-120b         — succeeds but at 90-135s, far past
 *    any reasonable interactive budget
 *
 * Disabling them keeps auto-route inside the fast lane (Cerebras qwen-3-235b
 * primary, CF kimi-k2.6 + CF gpt-oss as backups) so a burst doesn't drop
 * into a 135s zombie cascade. Re-enable from the panel any time.
 */
function migrateModelsV47DisableSlowFreeTierModels(db: Database.Database) {
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE (platform = 'nvidia' AND model_id IN (
              'deepseek-ai/deepseek-v4-flash',
              'moonshotai/kimi-k2.6',
              'minimaxai/minimax-m2.7'
            ))
        OR (platform = 'groq' AND model_id = 'openai/gpt-oss-120b')
  `).run();
  applyQualityOrder(db);
}

/**
 * V52 (May 2026): add Moonshot Kimi K2.6 free tier via OpenRouter.
 *
 * OpenRouter now publishes a zero-cost `moonshotai/kimi-k2.6:free` slug
 * (live /models probe: input $0 / output $0, 262K context). K2.6 is the
 * current Moonshot frontier non-thinking model — supports tool calling and
 * JSON mode, so it slots into the auto-route chain near the top of the free
 * pool (intelligence_rank 1, same shared 20 RPM / 200 RPD / ~6M token budget
 * as the rest of the OpenRouter :free models).
 *
 * NOTE: the NVIDIA `moonshotai/kimi-k2.6` row was disabled in V47 for TTFB
 * timeouts under burst — this is a different platform (OpenRouter) and a
 * different (free, hosted) deployment, so the two do not conflict.
 *
 * Poolside was evaluated as a second source for K2.6 but rejected: it serves
 * only its own models (Laguna / Malibu / Point) behind a per-deployment,
 * enterprise-only OpenAI-compatible endpoint — no public free tier and no
 * Kimi hosting. Not added.
 *
 * Idempotent: INSERT OR IGNORE + applyQualityOrder recomputes the cascade.
 */
function migrateModelsV52OpenRouterKimiK26(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', 1, 0)
  `);
  db.transaction(() => {
    insert.run(
      'openrouter', 'moonshotai/kimi-k2.6:free', 'Kimi K2.6 (free)',
      1, 9, 'Frontier', 20, 200, null, null, '~6M', 262144,
    );
    // Wire the new row into the fallback chain if it isn't already; the
    // priority value is provisional — applyQualityOrder rewrites it.
    const row = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform = 'openrouter'
        AND m.model_id = 'moonshotai/kimi-k2.6:free'
    `).get() as { id: number } | undefined;
    if (row) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(row.id, maxPriority + 1);
    }
  })();
  applyQualityOrder(db);
}

/**
 * V53 (May 2026): demote Cloudflare Kimi K2.6 to the bottom of the chain.
 *
 * Stress test (2026-05-29, scripts/stress-kimi-k26.py) found
 * `@cf/moonshotai/kimi-k2.6` returns HTTP 502 Bad Gateway under burst load and
 * trips its own cooldown — only 3/50 pinned requests were actually served by
 * it; the rest cascaded to NVIDIA. Operator decision: keep it ENABLED (so an
 * idle-time call or an explicit pin can still use it) but force it to the
 * lowest priority. The demotion itself lives in `qualityRank.ts`
 * (CHRONIC_UNRELIABLE_DEMOTE); this migration just re-runs applyQualityOrder
 * so the new penalty is reflected in fallback_config.priority.
 *
 * Idempotent.
 */
function migrateModelsV53DemoteKimiK26CF(db: Database.Database) {
  applyQualityOrder(db);
}

/**
 * V41 (May 2026): image catalog cleanup — remove dead / fake image models.
 *
 * A live image-model comparison surfaced two problems:
 *  - Zhipu CogView (cogview-3 / -flash / -plus): every call fails and
 *    cascades away (probe: pinning cogview-3-plus routed via pollinations).
 *    CogView image-gen is no longer working on the Zhipu key — disable.
 *  - Pollinations: image.pollinations.ai/models now lists only ONE model.
 *    Our 8 pollinations rows (flux, turbo, flux-pro, flux-realism,
 *    flux-anime, flux-3d, midjourney, gptimage) are NOT distinct upstream —
 *    every unrecognised model name silently falls back to the same default,
 *    so they all return identical output. Keep a single `pollinations/flux`
 *    row as a keyless last-resort fallback and disable the 7 duplicates.
 *
 * Net image catalog after this: cloudflare FLUX.2 klein-9b + FLUX.1 schnell
 * (primary), pollinations/flux (keyless fallback), classic CF Stable
 * Diffusion rows (dated, bottom of chain). Re-runs applyQualityOrder.
 */
function migrateModelsV41ImageCatalogCleanup(db: Database.Database) {
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'zhipu'
       AND modality = 'image_gen'
       AND model_id IN ('cogview-3', 'cogview-3-flash', 'cogview-3-plus')
  `).run();
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'pollinations'
       AND model_id IN ('pollinations/turbo', 'pollinations/flux-pro',
                         'pollinations/flux-realism', 'pollinations/flux-anime',
                         'pollinations/flux-3d', 'pollinations/midjourney',
                         'pollinations/gptimage')
  `).run();
  applyQualityOrder(db);
}

/**
 * V40 (May 2026): disable the DeepSeek direct provider.
 *
 * DeepSeek's API is pay-as-you-go with no free daily tier — the account is
 * out of balance and every call returns 402 Insufficient Balance. The smart
 * cooldown day-locks it, but it still wastes a cascade slot each UTC day.
 * Per operator decision (no top-up planned), disable both DeepSeek models.
 * DeepSeek-family models hosted on OTHER providers (nvidia deepseek-v4-*,
 * github deepseek-*, etc.) are unaffected — those are free.
 *
 * Re-runs applyQualityOrder. Idempotent.
 */
function migrateModelsV40DisableDeepSeek(db: Database.Database) {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'deepseek'`).run();
  applyQualityOrder(db);
}

/**
 * V39 (May 2026): disable models that return 404/403 for our accounts.
 *
 * Daily probe (modality-filtered after V38) found these returning hard
 * not-found / no-access errors — they are not transient rate limits:
 *  - NVIDIA NIM 404 Not Found: codellama-70b, codestral-22b-instruct-v0.1,
 *    llama-3.1-nemotron-ultra-253b-v1, palmyra-creative-122b,
 *    palmyra-fin-70b-32k, palmyra-med-70b-32k. These V35/V36 catalog rows
 *    are no longer served on the free NIM tier for this key.
 *  - GitHub Models 403 No access: microsoft/phi-4-mini-instruct.
 *
 * nemotron-ultra-253b was the V38 #1 model, so leaving it 404-ing wasted
 * the first cascade attempt on every auto-routed request.
 *
 * Re-runs applyQualityOrder so the chain re-sorts without the dead rows.
 * Idempotent.
 */
function migrateModelsV39DeadNvidiaGithub(db: Database.Database) {
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'nvidia'
       AND model_id IN ('meta/codellama-70b',
                         'mistralai/codestral-22b-instruct-v0.1',
                         'nvidia/llama-3.1-nemotron-ultra-253b-v1',
                         'writer/palmyra-creative-122b',
                         'writer/palmyra-fin-70b-32k',
                         'writer/palmyra-med-70b-32k')
  `).run();
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'github' AND model_id = 'microsoft/phi-4-mini-instruct'
  `).run();
  applyQualityOrder(db);
}

/**
 * V38 (May 2026): quality-based fallback ordering.
 *
 * Replaces insertion-order priority with a deterministic quality score
 * (60% intelligence / 40% speed, plus RPM/RPD capacity penalties and a
 * reasoning demote) followed by a provider-diversity pass. See
 * `lib/qualityRank.ts` for the formula.
 *
 * IMPORTANT for future migrations: any migration that adds new model rows
 * should call `applyQualityOrder(db)` at its end so the new models land in
 * their quality slot instead of at the bottom of the chain. The dashboard
 * also exposes a `quality` sort preset (routes/fallback.ts) for manual
 * re-sorting.
 *
 * Idempotent: re-running produces the same ordering.
 */
function migrateModelsV38QualityOrder(db: Database.Database) {
  applyQualityOrder(db);
}

/**
 * V35a (May 2026): `api_keys.expires_at` column for time-bounded providers.
 *
 * NVIDIA NIM dev keys expire 6 months after issue; we want the dashboard
 * + health check to surface the deadline before requests start 401-ing in
 * production. Column is nullable so non-expiring keys (CF, Google, etc.)
 * stay NULL.
 *
 * On apply, retro-fills expires_at for any nvidia key with NULL expiry,
 * defaulting to now + 6 months (so the first key gets a deadline even if
 * inserted before this migration ran).
 *
 * Idempotent ALTER + idempotent retro-fill (only writes where NULL).
 */
function migrateKeyExpiryV35(db: Database.Database) {
  try { db.exec(`ALTER TABLE api_keys ADD COLUMN expires_at TEXT`); }
  catch (e: any) { if (!(e?.message ?? '').includes('duplicate column')) throw e; }
  // Retro-fill nvidia keys (6-month TOS per NVIDIA Developer Program)
  db.prepare(`
    UPDATE api_keys
       SET expires_at = datetime(created_at, '+6 months')
     WHERE platform='nvidia' AND expires_at IS NULL
  `).run();
}

/**
 * V35b (May 2026): NVIDIA NIM catalog seed. Probed user-provided key
 * `seho-nvidia` returns 125 models; 2 chat probes (llama-3.3-70b,
 * deepseek-v4-flash) returned 200. Adding the high-utility cluster only;
 * the full 125 is overkill for fallback chain length.
 *
 * Rate limit: 40 RPM free tier per key (per NVIDIA TOS).
 * Expiry: 6 months from creation date — see V35a.
 *
 * Selected (chat + embed + vision):
 *   meta/llama-3.3-70b-instruct        chat, general
 *   deepseek-ai/deepseek-v4-flash      chat, frontier (free here vs 402 on direct)
 *   deepseek-ai/deepseek-v4-pro        chat, frontier
 *   nvidia/llama-3.3-nemotron-super-49b-v1.5  chat, reasoning-tuned
 *   nvidia/llama-3.1-nemotron-ultra-253b-v1   chat, massive
 *   meta/llama-3.2-90b-vision-instruct vision
 *   meta/llama-3.2-11b-vision-instruct vision (smaller)
 *   microsoft/phi-4-multimodal-instruct multimodal
 *   mistralai/codestral-22b-instruct-v0.1 code
 *   nvidia/llama-3.2-nv-embedqa-1b-v1 embedding
 *   nvidia/llama-nemotron-embed-1b-v2 embedding (newer)
 */
function migrateModelsV35NvidiaCatalog(db: Database.Database) {
  const insChat = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?)
  `);
  const insVision = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning, vision_capable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?, ?)
  `);
  const insEmbed = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'embedding', 0, 0)
  `);
  // [pl, id, name, intel, speed, size, rpm, rpd, tpm, tpd, budget, ctx, json, reasoning]
  insChat.run('nvidia','meta/llama-3.3-70b-instruct',                'Llama 3.3 70B (NVIDIA)',          4,  7, 'Large',    40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','deepseek-ai/deepseek-v4-flash',              'DeepSeek V4 Flash (NVIDIA)',      3,  6, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','deepseek-ai/deepseek-v4-pro',                'DeepSeek V4 Pro (NVIDIA)',        2,  5, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','nvidia/llama-3.3-nemotron-super-49b-v1.5',   'Nemotron Super 49B (reasoning)',  5,  6, 'Large',    40, null, null, null, '~RPM-capped', 131072, 0, 1);
  insChat.run('nvidia','nvidia/llama-3.1-nemotron-ultra-253b-v1',    'Nemotron Ultra 253B',             2,  4, 'Frontier', 40, null, null, null, '~RPM-capped', 131072, 1, 0);
  insChat.run('nvidia','mistralai/codestral-22b-instruct-v0.1',      'Codestral 22B (NVIDIA, code)',    13, 7, 'Medium',   40, null, null, null, '~RPM-capped', 32768,  0, 0);
  insVision.run('nvidia','meta/llama-3.2-90b-vision-instruct',       'Llama 3.2 90B Vision (NVIDIA)',    5,  5, 'Large',    40, null, null, null, '~RPM-capped', 131072, 1, 0, 1);
  insVision.run('nvidia','meta/llama-3.2-11b-vision-instruct',       'Llama 3.2 11B Vision (NVIDIA)',    9,  7, 'Medium',   40, null, null, null, '~RPM-capped', 131072, 1, 0, 1);
  insVision.run('nvidia','microsoft/phi-4-multimodal-instruct',      'Phi-4 multimodal (NVIDIA)',        8,  7, 'Medium',   40, null, null, null, '~RPM-capped', 16000,  1, 0, 1);
  insEmbed.run( 'nvidia','nvidia/llama-3.2-nv-embedqa-1b-v1',        'NV-EmbedQA 1B v1',                14,  8, 'Embed',    40, null, null, null, '~RPM-capped', 8192);
  insEmbed.run( 'nvidia','nvidia/llama-nemotron-embed-1b-v2',        'Nemotron Embed 1B v2',            12,  8, 'Embed',    40, null, null, null, '~RPM-capped', 8192);

  const apply = db.transaction(() => {
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.enabled=1 AND m.platform='nvidia'
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxP = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxP + i + 1);
    }
  });
  apply();
}

/**
 * V34 (May 2026): rerank catalog seed (NEW modality 'rerank').
 *
 * Used in RAG pipelines after embedding retrieval to refine top-K
 * documents. POST /v1/rerank body {query, documents[]} -> sorted results
 * with relevance scores. Currently only Cohere provides this on free trial
 * (1000 calls/month).
 *
 * Catalog seeds:
 *   rerank-v3.5         — best quality, multilingual, 4K tokens/doc
 *   rerank-v4.0-fast    — speed-tuned variant
 *   rerank-v4.0-pro     — higher accuracy than v3.5
 *
 * Probed live: TR query "satılık daire İstanbul" against 5 docs returned
 * correct ordering (Kadıköy lüks daire 0.66 top).
 */
function migrateModelsV34RerankCatalog(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'rerank', 0, 0)
  `);
  insert.run('cohere', 'rerank-v3.5',       'Cohere Rerank v3.5 (multilingual)', 5,  6, 'Rerank', 10, 1000, null, null, '~1000 call/mo', 4096);
  insert.run('cohere', 'rerank-v4.0-fast',  'Cohere Rerank v4.0 Fast',           7,  8, 'Rerank', 10, 1000, null, null, '~1000 call/mo', 4096);
  insert.run('cohere', 'rerank-v4.0-pro',   'Cohere Rerank v4.0 Pro',            3,  5, 'Rerank', 10, 1000, null, null, '~1000 call/mo', 4096);

  const apply = db.transaction(() => {
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.enabled=1 AND m.modality='rerank'
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxP = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxP + i + 1);
    }
  });
  apply();
}

/**
 * V33 (May 2026): catalog expansion. Live /models probes across all our
 * platforms revealed dozens of newer / smaller / specialized models we'd
 * missed since the original V22 seed. Adding the high-confidence entries
 * verified to work on the free tier of the existing API keys.
 *
 * Skipped (probed to be locked / paid):
 *   github openai/gpt-5-*, o4-mini, xai/grok-3-mini -> "Unavailable model"
 *   google imagen-4 / veo / lyria / gemini-3-pro-image -> billing required
 *   mistral pixtral-large / mistral-large-2512 -> paid tier
 *
 * Documented in `docs/FREE-PROVIDERS-RESEARCH.md §F (V33)`.
 *
 * Modalities still to wire (provider impl changes needed, NOT just catalog):
 *   groq canopylabs/orpheus-* -> TTS (different audio path)
 *   mistral voxtral-* -> STT (different audio path)
 *   cohere cohere-transcribe-* -> STT (Cohere has separate /v1/transcribe)
 *   cohere rerank-* -> rerank (new modality)
 *
 * Idempotent (INSERT OR IGNORE) + fallback_config orphan sweep.
 */
function migrateModelsV33CatalogExpansion(db: Database.Database) {
  const insChat = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?)
  `);
  const insChatVision = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning, vision_capable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?, ?)
  `);
  const insEmbed = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'embedding', 0, 0)
  `);

  // ---- GitHub Models (Azure proxy, free monthly quota) ----
  // Probed: llama-4-scout + phi-4 return 200. Adding the safe cluster.
  insChat.run('github', 'openai/gpt-4o-mini',                'GPT-4o mini (GH)',          5,  8, 'Medium', 10, null, null, null, '~free monthly', 128000, 1, 0);
  insChat.run('github', 'openai/gpt-4.1-mini',               'GPT-4.1 mini (GH)',         5,  8, 'Medium', 10, null, null, null, '~free monthly', 128000, 1, 0);
  insChat.run('github', 'openai/gpt-4.1-nano',               'GPT-4.1 nano (GH)',         7,  9, 'Small',  10, null, null, null, '~free monthly', 128000, 1, 0);
  insChat.run('github', 'openai/o1-mini',                    'OpenAI o1-mini (GH)',       4,  4, 'Large',  10, null, null, null, '~free monthly', 128000, 0, 1);
  insChat.run('github', 'meta/llama-4-scout-17b-16e-instruct','Llama 4 Scout 17B (GH)',   6,  7, 'Large',  10, null, null, null, '~free monthly', 128000, 1, 0);
  insChat.run('github', 'meta/llama-3.3-70b-instruct',       'Llama 3.3 70B (GH)',        4,  6, 'Large',  10, null, null, null, '~free monthly', 128000, 1, 0);
  insChat.run('github', 'microsoft/phi-4',                   'Phi-4 (GH)',                7,  8, 'Medium', 10, null, null, null, '~free monthly', 16000,  1, 0);
  insChat.run('github', 'microsoft/phi-4-mini-instruct',     'Phi-4 mini (GH)',           9,  9, 'Small',  10, null, null, null, '~free monthly', 16000,  1, 0);
  insChat.run('github', 'microsoft/phi-4-reasoning',         'Phi-4 reasoning (GH)',      5,  6, 'Medium', 10, null, null, null, '~free monthly', 16000,  0, 1);
  insChat.run('github', 'deepseek/deepseek-r1',              'DeepSeek R1 (GH)',          4,  6, 'Frontier',10,null, null, null, '~free monthly', 131072, 0, 1);
  insChat.run('github', 'deepseek/deepseek-v3-0324',         'DeepSeek V3 (GH, 0324)',    5,  6, 'Frontier',10,null, null, null, '~free monthly', 131072, 1, 0);
  insChat.run('github', 'mistral-ai/codestral-2501',         'Codestral 2501 (GH)',       12, 7, 'Medium', 10, null, null, null, '~free monthly', 32768,  0, 0);
  insChat.run('github', 'mistral-ai/ministral-3b',           'Ministral 3B (GH)',         18, 9, 'Small',  10, null, null, null, '~free monthly', 32768,  1, 0);
  insChat.run('github', 'mistral-ai/mistral-medium-2505',    'Mistral Medium 2505 (GH)',  10, 6, 'Large',  10, null, null, null, '~free monthly', 131072, 1, 0);
  insChat.run('github', 'mistral-ai/mistral-small-2503',     'Mistral Small 2503 (GH)',   15, 8, 'Medium', 10, null, null, null, '~free monthly', 32768,  1, 0);
  // Vision-capable GH models
  insChatVision.run('github', 'meta/llama-3.2-11b-vision-instruct','Llama 3.2 11B Vision (GH)', 9, 7, 'Medium', 10, null, null, null, '~free monthly', 128000, 1, 0, 1);
  insChatVision.run('github', 'meta/llama-3.2-90b-vision-instruct','Llama 3.2 90B Vision (GH)', 5, 5, 'Large',  10, null, null, null, '~free monthly', 128000, 1, 0, 1);
  insChatVision.run('github', 'microsoft/phi-4-multimodal-instruct','Phi-4 multimodal (GH)',    8, 7, 'Medium', 10, null, null, null, '~free monthly', 16000,  1, 0, 1);
  // GH embedding-3-small (we already have -large)
  insEmbed.run('github',    'openai/text-embedding-3-small', 'OpenAI Embedding 3 Small (GH)', 10, 8, 'Embed', 10, null, null, null, '~free monthly', 8192);

  // ---- Cerebras new ----
  // llama3.1-8b probed earlier as 4-model live list entry; treat as free tier
  insChat.run('cerebras', 'llama3.1-8b',                     'Llama 3.1 8B (Cerebras)',   18, 9, 'Small', 30, null, null, null, '~30M', 131072, 1, 0);

  // ---- Zhipu newer GLM (free tier subject to per-account quota) ----
  insChat.run('zhipu',    'glm-4.6',                         'GLM 4.6 (Zhipu)',           7,  6, 'Large', 30, null, null, null, '~30M', 128000, 1, 0);
  insChat.run('zhipu',    'glm-4.5',                         'GLM 4.5 (Zhipu)',           9,  7, 'Large', 30, null, null, null, '~30M', 128000, 1, 0);
  insChat.run('zhipu',    'glm-4.5-air',                     'GLM 4.5 Air (Zhipu)',       12, 8, 'Medium',30, null, null, null, '~30M', 128000, 1, 0);

  // ---- Mistral expansion ----
  insChat.run('mistral',  'magistral-small-latest',          'Magistral Small (reasoning)', 13, 7, 'Medium', 30, null, null, null, '~free', 40000, 0, 1);
  insChat.run('mistral',  'ministral-8b-latest',             'Ministral 8B',                 17, 8, 'Small',  30, null, null, null, '~free', 131072, 1, 0);
  insChat.run('mistral',  'ministral-3b-latest',             'Ministral 3B',                 20, 9, 'Small',  30, null, null, null, '~free', 131072, 1, 0);
  insChat.run('mistral',  'mistral-small-latest',            'Mistral Small (latest)',       12, 7, 'Medium', 30, null, null, null, '~free', 131072, 1, 0);

  // ---- OpenRouter free additions ----
  insChat.run('openrouter','meta-llama/llama-3.2-3b-instruct:free', 'Llama 3.2 3B (free)', 19, 8, 'Small', 20, 200, null, null, '~6M', 131072, 1, 0);
  insChat.run('openrouter','nousresearch/hermes-3-llama-3.1-405b:free', 'Hermes 3 405B (free)', 6, 4, 'Frontier', 20, 200, null, null, '~6M', 131072, 1, 0);

  // Wire any new enabled rows into fallback_config
  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE f.id IS NULL AND m.enabled = 1
      AND m.platform IN ('github','cerebras','zhipu','mistral','openrouter')
  `).all() as { id: number }[];
  if (missing.length > 0) {
    const maxP = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxP + i + 1);
  }
}

/**
 * V32 (May 2026): two catalog additions.
 *
 *  (1) Mistral `codestral-latest` — code-completion-tuned chat model.
 *      Probed: api.mistral.ai/v1 accepts codestral-latest with the existing
 *      Mistral La Plateforme key (regular chat key works; the dedicated
 *      codestral.mistral.ai endpoint needs a separate key we don't have).
 *      Free tier rate limit: ~30 req/min, ~2000 req/day per Mistral docs.
 *
 *  (2) Cloudflare `@cf/myshell-ai/melotts` — multi-lingual text-to-speech.
 *      modality='audio_tts' (new). Body {prompt, lang}. Returns base64 MP3.
 *      Supports en/es/fr/zh/ja/ko. ~30 neurons/call (cheap).
 *
 * Idempotent: INSERT OR IGNORE; fallback_config wiring skips already-wired rows.
 */
function migrateModelsV32CodestralAndTTS(db: Database.Database) {
  const insertChat = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', ?, ?)
  `);
  const insertTts = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning, neurons_per_call
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'audio_tts', 0, 0, ?)
  `);
  insertChat.run('mistral', 'codestral-latest', 'Mistral Codestral (code)', 14, 6, 'Medium', 30, 2000, null, null, '~free', 32768, 0, 0);
  insertTts.run('cloudflare', '@cf/myshell-ai/melotts', 'MeloTTS (CF, multilingual)', 20, 7, 'TTS', null, null, null, null, '~10K neurons/day', 0, 30);

  const apply = db.transaction(() => {
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.enabled = 1
        AND ((m.platform='mistral' AND m.model_id='codestral-latest')
          OR (m.platform='cloudflare' AND m.model_id='@cf/myshell-ai/melotts'))
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxP = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxP + i + 1);
    }
  });
  apply();
}

/**
 * V31 (May 2026): batch_items endpoint column for multi-endpoint batches.
 *
 * Faz 2 of the embeddings rollout extends the existing batch infrastructure
 * to handle /v1/embeddings as well as /v1/chat/completions. Each row now
 * records which endpoint to dispatch to, defaulting to /v1/chat/completions
 * so historical rows stay compatible. BatchWorker.processItem switches on
 * this column to call runChatCompletion vs runEmbedding.
 *
 * Idempotent — wraps ALTER TABLE in try/catch on "duplicate column" because
 * SQLite has no IF NOT EXISTS clause for columns.
 */
function migrateBatchItemsV31Endpoint(db: Database.Database) {
  try {
    db.exec(`ALTER TABLE batch_items ADD COLUMN endpoint TEXT NOT NULL DEFAULT '/v1/chat/completions'`);
  } catch (e: any) {
    if (!(e?.message ?? '').includes('duplicate column')) throw e;
  }
}

/**
 * V30 (May 2026): seed text-embedding catalog rows for the /v1/embeddings
 * endpoint. modality='embedding'. Six providers cover the free / generous
 * free-tier landscape:
 *
 *   cloudflare  bge-m3 (multilingual), bge-large-en-v1.5, bge-base-en-v1.5,
 *               bge-small-en-v1.5   -> ~5-10 neurons/call, 10K/day cap per key
 *   google      gemini-embedding-001 (Matryoshka 768d)
 *   cohere      embed-multilingual-v3.0, embed-english-v3.0, embed-v4.0
 *   mistral     mistral-embed (1024d)
 *   zhipu       embedding-3 (1024d), embedding-2 (1024d)
 *   github      openai/text-embedding-3-large (3072d via Azure proxy)
 *
 * Default fallback order (priority asc): CF bge-m3 -> Google -> Cohere
 * multilingual -> Mistral -> Zhipu -> GitHub. Reliable + free CF first;
 * Google second for quality; Cohere for the 1000 call/month trial; the
 * rest as cascade fallback. Idempotent via INSERT OR IGNORE.
 */
function migrateModelsV30EmbeddingCatalog(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'embedding', 0, 0)
  `);
  // [platform, model_id, display_name, intel, speed, size, rpm, rpd, tpm, tpd, budget, ctx]
  const rows: Array<[string, string, string, number, number, string,
                     number | null, number | null, number | null, number | null,
                     string, number]> = [
    // Cloudflare BGE (free 10K neurons/day)
    ['cloudflare', '@cf/baai/bge-m3',              'BGE-M3 (CF, multilingual)',    20, 8, 'Embed', 60, null, null, null, '~10K neurons/day', 8192],
    ['cloudflare', '@cf/baai/bge-large-en-v1.5',  'BGE Large EN (CF)',            22, 8, 'Embed', 60, null, null, null, '~10K neurons/day', 512],
    ['cloudflare', '@cf/baai/bge-base-en-v1.5',   'BGE Base EN (CF)',             24, 9, 'Embed', 60, null, null, null, '~10K neurons/day', 512],
    ['cloudflare', '@cf/baai/bge-small-en-v1.5',  'BGE Small EN (CF)',            26, 9, 'Embed', 60, null, null, null, '~10K neurons/day', 512],
    // Google Gemini embedding (free tier RPM-capped)
    ['google',     'gemini-embedding-001',         'Gemini Embedding 001',         15, 7, 'Embed', 10, 1500, null, null, '~free RPM', 2048],
    // Cohere v3/v4 (1000 call/month trial)
    ['cohere',     'embed-multilingual-v3.0',      'Cohere Embed Multilingual v3', 12, 6, 'Embed', 10, 1000, null, null, '~1000 call/mo', 512],
    ['cohere',     'embed-english-v3.0',           'Cohere Embed English v3',      13, 6, 'Embed', 10, 1000, null, null, '~1000 call/mo', 512],
    ['cohere',     'embed-v4.0',                   'Cohere Embed v4',              10, 6, 'Embed', 10, 1000, null, null, '~1000 call/mo', 128000],
    // Mistral embed (free tier)
    ['mistral',    'mistral-embed',                'Mistral Embed',                17, 7, 'Embed', 30, null, null, null, '~free', 8192],
    // Zhipu embed
    ['zhipu',      'embedding-3',                  'Zhipu Embedding 3',            18, 7, 'Embed', 30, null, null, null, '~free', 8192],
    ['zhipu',      'embedding-2',                  'Zhipu Embedding 2',            22, 7, 'Embed', 30, null, null, null, '~free', 8192],
    // GitHub Models text-embedding-3-large (Azure proxy)
    ['github',     'openai/text-embedding-3-large','OpenAI Embedding 3 Large (GH)', 8, 6, 'Embed', 10, null, null, null, '~free monthly', 8192],
  ];
  const apply = db.transaction(() => {
    for (const r of rows) insert.run(...r);
    // Wire all freshly-inserted embedding rows into fallback_config so the
    // router has something to pick. Same pattern as V22 chat-providers seed.
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.modality='embedding' AND m.enabled=1
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}

/**
 * V29 (May 2026): backfill `requests.modality` for historical image / audio
 * rows.
 *
 * Bug shipped between Faz 4 image-gen rollout and V28: logRequest()'s
 * INSERT didn't include the `modality` column, so SQLite used the column
 * default ('text') for every row regardless of whether the request was
 * text-chat, image-gen, image-edit, or audio. Analytics /summary's image
 * panel therefore showed 0 images because the modality filter excluded
 * every row.
 *
 * Fix forward shipped alongside V29 source change (logRequest now writes
 * modality explicitly). This migration backfills historical rows by joining
 * to models.modality on platform+model_id. Idempotent: only updates rows
 * still tagged 'text' but whose catalog modality says otherwise.
 */
function migrateRequestsV29ModalityBackfill(db: Database.Database) {
  db.prepare(`
    UPDATE requests
       SET modality = (
         SELECT m.modality FROM models m
          WHERE m.platform = requests.platform
            AND m.model_id = requests.model_id
       )
     WHERE modality = 'text'
       AND EXISTS (
         SELECT 1 FROM models m
          WHERE m.platform = requests.platform
            AND m.model_id = requests.model_id
            AND m.modality IS NOT NULL
            AND m.modality != 'text'
       )
  `).run();
}

/**
 * V28 (May 2026): Cloudflare FLUX.2 klein-9b — unified T2I + img2img on CF
 * Workers AI free tier. Launched Jan 2026, multipart/form-data API.
 *
 * Why: Pollinations flux is a distilled/quantized variant; CF FLUX.2 is the
 * real BFL Flux.2 model, much higher quality. Both T2I + i2i in one model,
 * 4-step inference (~1.2s latency). Same CF key, no extra signup.
 *
 * Catalog row marked supports_img2img=1, modality=image_gen. Priority slot
 * inserted before Pollinations so router prefers FLUX.2 first; Pollinations
 * remains as fallback. Idempotent: INSERT OR IGNORE.
 */
function migrateModelsV28CfFlux2(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_img2img, supports_inpainting, neurons_per_call
    ) VALUES ('cloudflare', '@cf/black-forest-labs/flux-2-klein-9b',
              'FLUX.2 klein 9B (CF)',
              10, 8, 'Large', null, null, null, null, '~10K neurons/day', 0,
              1, 'image_gen', 1, 0, 120)
  `);
  insert.run();

  // Wire into fallback_config before Pollinations (lower priority number = tried first)
  const flux2Id = (db.prepare(`SELECT id FROM models WHERE platform='cloudflare' AND model_id='@cf/black-forest-labs/flux-2-klein-9b'`).get() as { id: number } | undefined)?.id;
  if (flux2Id) {
    const existing = db.prepare(`SELECT priority FROM fallback_config WHERE model_db_id=?`).get(flux2Id) as { priority: number } | undefined;
    if (!existing) {
      // Pollinations flux currently sits below CF SD priorities; place FLUX.2
      // just below the existing CF image rows (e.g. priority ~30 range).
      const minImagePriority = (db.prepare(`
        SELECT MIN(fc.priority) AS p
          FROM fallback_config fc
          JOIN models m ON m.id = fc.model_db_id
         WHERE m.modality='image_gen' AND m.platform='cloudflare'
      `).get() as { p: number | null }).p ?? 30;
      db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)`)
        .run(flux2Id, Math.max(1, minImagePriority - 1));
    }
  }
}

/**
 * V27 (May 2026): Pollinations.ai flux supports img2img via `?image=URL`.
 * CF retired img2img across all SD models (V25); Pollinations is now the
 * only free provider supporting plain img2img / variations. Probed live:
 * GET image.pollinations.ai/prompt/<p>?model=flux&image=<srcUrl> -> 200.
 *
 * Inpainting (mask) still requires CF SD-1.5-inpainting since Pollinations
 * doesn't accept a mask parameter. Idempotent UPDATE.
 */
function migrateModelsV27PollinationsImg2Img(db: Database.Database) {
  db.prepare(`UPDATE models SET supports_img2img = 1
              WHERE platform = 'pollinations' AND model_id = 'pollinations/flux'`).run();
}

/**
 * V26 (May 2026): rebalance fallback priorities to reduce 429 cascade spam.
 *
 * Prod 7d analytics showed ~196 errors (~25% of all rows) from 3 OpenRouter
 * free models in top-6 priorities (minimax-m2.5:free p1, qwen3-coder:free p3,
 * qwen3-next-80b:free p6). These free models are popular & saturated; every
 * request hit them first, ate a 429, then cascaded down.
 *
 * Fix: bump OpenRouter `:free` model priorities by +50 so reliable providers
 * (Cloudflare, SambaNova, Cerebras, Groq, GitHub Models) are tried first.
 * Free OpenRouter still in the chain — they just become "last-resort spillover"
 * instead of "first-attempt sacrificial lambs". Idempotent: only bumps rows
 * still in the original [1..49] range; second run is a no-op.
 */
function migrateModelsV26RebalancePriorities(db: Database.Database) {
  db.prepare(`
    UPDATE fallback_config
       SET priority = priority + 100
     WHERE model_db_id IN (
       SELECT id FROM models WHERE platform='openrouter' AND model_id LIKE '%:free'
     )
       AND priority < 100
  `).run();
}

/**
 * V25 (May 2026): Cloudflare img2img deprecated across all SD models.
 * Probed live (May 2026):
 *   - @cf/lykon/dreamshaper-8-lcm: "unexpected shape for input 'image'" (T2I only now)
 *   - @cf/stabilityai/stable-diffusion-xl-base-1.0: "input tensor `image` is not present in the model"
 *   - @cf/runwayml/stable-diffusion-v1-5-inpainting: REQUIRES mask_image (no plain img2img)
 *
 * Result: `/v1/images/edits` and `/v1/images/variations` without a mask have
 * no provider. Inpainting (edits with mask) + outpainting (server-built mask)
 * still work. Flag supports_img2img=0 on all CF SD rows.
 */
function migrateModelsV25CfImg2ImgDeprecated(db: Database.Database) {
  db.prepare(`UPDATE models SET supports_img2img = 0
              WHERE platform = 'cloudflare'
                AND model_id IN (
                  '@cf/lykon/dreamshaper-8-lcm',
                  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
                  '@cf/runwayml/stable-diffusion-v1-5-inpainting'
                )`).run();
}

/**
 * V24 (May 2026): catalog cleanup — disable dead/retired model_ids.
 *
 * Source: 7-day prod error log analysis (404/410/GONE/no-longer-available).
 *
 *   cerebras/qwen3-235b              — 404 Not Found (Cerebras retired)
 *   sambanova/DeepSeek-V3.1-cb       — 410 GONE (SambaNova retired -cb variant)
 *   openrouter/inclusionai/ling-2.6-1t:free   — moved to paid
 *   openrouter/nvidia/nemotron-nano-9b-v2:free — 404
 *   openrouter/tencent/hy3-preview:free      — moved to paid
 *
 * Idempotent: each UPDATE sets enabled=0; running twice is a no-op.
 */
function migrateModelsV24DeadCleanup(db: Database.Database) {
  const apply = db.transaction(() => {
    const stmt = db.prepare(`UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?`);
    const deadRows: Array<[string, string]> = [
      ['cerebras',   'qwen3-235b'],
      ['sambanova',  'DeepSeek-V3.1-cb'],
      ['openrouter', 'inclusionai/ling-2.6-1t:free'],
      ['openrouter', 'nvidia/nemotron-nano-9b-v2:free'],
      ['openrouter', 'tencent/hy3-preview:free'],
    ];
    for (const [p, m] of deadRows) stmt.run(p, m);
  });
  apply();
}

/**
 * V18 (May 2026): image-to-image / inpainting flags. Adds two columns:
 *   supports_img2img    — model accepts an input image + prompt + strength
 *   supports_inpainting — model accepts image + mask + prompt
 * Both default to 0. Existing CF image-gen rows updated where applicable
 * (only SD-1.5-inpainting handles both at the moment; FLUX-schnell + SDXL
 * Lightning are text-to-image only).
 */
function migrateModelsV18Img2Img(db: Database.Database) {
  try { db.exec(`ALTER TABLE models ADD COLUMN supports_img2img    INTEGER NOT NULL DEFAULT 0`); }
  catch (e: any) { if (!(e?.message ?? '').includes('duplicate column')) throw e; }
  try { db.exec(`ALTER TABLE models ADD COLUMN supports_inpainting INTEGER NOT NULL DEFAULT 0`); }
  catch (e: any) { if (!(e?.message ?? '').includes('duplicate column')) throw e; }

  // Flag known CF rows.
  db.prepare(`UPDATE models SET supports_img2img = 1, supports_inpainting = 1
              WHERE platform = 'cloudflare' AND model_id = '@cf/runwayml/stable-diffusion-v1-5-inpainting'`).run();
  db.prepare(`UPDATE models SET supports_img2img = 1
              WHERE platform = 'cloudflare' AND model_id = '@cf/lykon/dreamshaper-8-lcm'`).run();
  db.prepare(`UPDATE models SET supports_img2img = 1
              WHERE platform = 'cloudflare' AND model_id = '@cf/stabilityai/stable-diffusion-xl-base-1.0'`).run();
}

/**
 * V17 (May 2026): image_files registry for response_format='url' delivery.
 * Image bytes live on local FS (server/data/images/<ulid>.<ext>); this table
 * stores the registry + signed-URL metadata. A retention sweeper deletes both
 * the row and the file once expires_at has passed.
 */
function migrateImageFilesV17(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_files (
      id           TEXT PRIMARY KEY,         -- ULID
      file_path    TEXT NOT NULL,            -- absolute path on disk
      mime_type    TEXT NOT NULL,
      byte_size    INTEGER NOT NULL,
      platform     TEXT,                     -- producer platform for analytics
      model_id     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_files_expires ON image_files(expires_at);
  `);
}

/**
 * Persisted per-key per-model daily counters. Survives pm2 restart so RPD/TPD
 * enforcement isn't reset to zero by a routine bounce. window_start is the
 * UTC midnight floor for the day this row represents.
 *
 * Adaptive cooldowns table — when a provider returns a daily quota error, we
 * set a long cooldown (e.g. until UTC midnight); when it's just a minute
 * burst, we use a short one. Survives restart too.
 */
function migrateUsageCounters(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      platform        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      key_id          INTEGER NOT NULL,
      window_start    TEXT NOT NULL,   -- UTC date 'YYYY-MM-DD' for daily
      requests        INTEGER NOT NULL DEFAULT 0,
      tokens          INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (platform, model_id, key_id, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_window ON usage_counters(window_start);

    CREATE TABLE IF NOT EXISTS cooldowns (
      platform   TEXT NOT NULL,
      model_id   TEXT NOT NULL,
      key_id     INTEGER NOT NULL,
      expires_at TEXT NOT NULL,        -- ISO8601 UTC
      reason     TEXT NOT NULL,        -- 'rate_limit_minute'|'rate_limit_day'|'rate_limit_unknown'|'invalid_key'
      PRIMARY KEY (platform, model_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cooldowns_expiry ON cooldowns(expires_at);
  `);

  // Drop counter rows older than 7 days so the table doesn't grow forever.
  db.prepare(`DELETE FROM usage_counters WHERE window_start < date('now','-7 days')`).run();
  // Drop expired cooldowns.
  db.prepare(`DELETE FROM cooldowns WHERE expires_at < datetime('now')`).run();
}

function ensureUnifiedKey(db: Database.Database) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!existing) {
    const key = `myllm-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    console.log(`\n  Your unified API key: ${key}\n`);
  }
}

export function getUnifiedApiKey(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `myllm-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}

/**
 * V44 — Client API key table.
 *
 * The unified key in `settings` is a single shared secret. Splitting it into
 * named per-project keys lets analytics attribute "this much spend is from
 * project X". Stored as SHA-256(plain) so a DB leak does not reveal the key;
 * the plain value is only returned once at creation time.
 */
function migrateClientKeysV44(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_keys_hash ON client_keys(key_hash);
  `);
}

/**
 * V45 — Per-request client-key attribution.
 *
 * Adds requests.client_key_id (nullable; pre-existing rows stay NULL and
 * surface as "Bilinmeyen" in the by-key analytics breakdown).
 */
function migrateRequestsV45ClientKeyId(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'client_key_id')) {
    db.exec(`
      ALTER TABLE requests ADD COLUMN client_key_id INTEGER;
      CREATE INDEX IF NOT EXISTS idx_requests_client_key ON requests(client_key_id);
    `);
  }
}

/**
 * V46 — Seed the existing unified_api_key into client_keys as "Genel".
 *
 * Keeps the original key working so every project pointing at the unified key
 * (Cline, EmlakCopilot, MCP, etc.) continues authenticating; their traffic is
 * just attributed to the "Genel" row in analytics. Idempotent.
 */
function migrateClientKeysV46SeedGeneral(db: Database.Database) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!existing?.value) return;
  const hash = crypto.createHash('sha256').update(existing.value).digest('hex');
  const already = db.prepare('SELECT id FROM client_keys WHERE key_hash = ?').get(hash) as { id: number } | undefined;
  if (already) return;
  const prefix = existing.value.slice(0, 16);
  db.prepare(`
    INSERT INTO client_keys (id, name, key_hash, key_prefix, enabled)
    VALUES (1, 'Default', ?, ?, 1)
  `).run(hash, prefix);
}

/**
 * V48 — rename the seeded id=1 row from the original Turkish "Genel" to the
 * English "Default" to keep the dashboard fully English. No-op on a fresh DB
 * (V46 already writes "Default"); on existing prod data we update id=1 only,
 * and only if its current name is still "Genel".
 */
function migrateClientKeysV48RenameGeneralToDefault(db: Database.Database) {
  db.prepare("UPDATE client_keys SET name = 'Default' WHERE id = 1 AND name = 'Genel'").run();
}

/**
 * V50 — soft-delete column.
 *
 * Hard DELETE on a client_key orphans every request row that pointed at it
 * (client_key_id keeps the now-dangling id, LEFT JOIN nulls the name → the
 * traffic shows as "Unknown" in the by-key analytics). Add deleted_at so the
 * row stays attributable even after the operator removes the key from the
 * panel. The list endpoint hides soft-deleted rows; the analytics JOIN still
 * resolves the name.
 */
function migrateClientKeysV50SoftDelete(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(client_keys)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE client_keys ADD COLUMN deleted_at TEXT');
  }
}

/**
 * V51 — back-fill placeholder rows for client_key_ids that were hard-deleted
 * before V50. Any request that points at a now-missing client_keys row gets a
 * synthetic "Deleted #N" row inserted so the by-key analytics LEFT JOIN
 * resolves a name instead of bucketing it into "Unknown" (which is reserved
 * for genuinely unattributed pre-V45 traffic with NULL client_key_id).
 *
 * Real names are unrecoverable — the original rows are gone. Operator can
 * read past traffic as "this attribution belonged to a key now removed".
 */
function migrateClientKeysV51BackfillOrphans(db: Database.Database) {
  const orphans = db.prepare(`
    SELECT DISTINCT r.client_key_id AS id
    FROM requests r
    WHERE r.client_key_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM client_keys ck WHERE ck.id = r.client_key_id)
  `).all() as Array<{ id: number }>;
  if (orphans.length === 0) return;
  const ins = db.prepare(`
    INSERT INTO client_keys (id, name, key_hash, key_prefix, enabled, deleted_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'))
  `);
  for (const o of orphans) {
    // Synthetic hash/prefix so the row never authenticates anything — only
    // serves as a label-bearer for analytics. Hash is unique per orphan id.
    const stub = `orphan-${o.id}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      ins.run(o.id, `Deleted #${o.id}`, stub, 'deleted');
    } catch { /* row may already exist as a regular soft-deleted entry */ }
  }
}

/**
 * V54 — end-user attribution + cost tracking on requests.
 * Adds end_user_id TEXT, cost_micro INTEGER columns and a covering index.
 */
function migrateRequestsV54EndUser(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'end_user_id')) {
    db.exec('ALTER TABLE requests ADD COLUMN end_user_id TEXT');
  }
  if (!cols.some(c => c.name === 'cost_micro')) {
    db.exec('ALTER TABLE requests ADD COLUMN cost_micro INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_enduser
      ON requests(client_key_id, end_user_id, created_at)
  `);
}

/**
 * V55 — per-model pricing columns + global default settings.
 */
function migrateModelsV55Pricing(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'price_input_per_1m')) {
    db.exec('ALTER TABLE models ADD COLUMN price_input_per_1m REAL');
  }
  if (!cols.some(c => c.name === 'price_output_per_1m')) {
    db.exec('ALTER TABLE models ADD COLUMN price_output_per_1m REAL');
  }
  if (!cols.some(c => c.name === 'price_per_call')) {
    db.exec('ALTER TABLE models ADD COLUMN price_per_call REAL');
  }
  // Default pricing baseline = Gemini 3.1 Flash-Lite ($0.25/M in, $1.50/M out).
  // The cheapest paid model we'd realistically swap to, so cost_micro is an
  // honest "what this traffic costs on the cheapest alternative" figure.
  db.exec(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('default_price_input_per_1m',  '0.25');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('default_price_output_per_1m', '1.50');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('default_price_per_call',       '0.04');
  `);
}

/**
 * V58 — migrate the live default pricing from the old GPT-4o baseline ($3/$15
 * per 1M) to Gemini 3.1 Flash-Lite ($0.25/$1.50). Only rewrites rows still
 * holding the exact old default, so an operator's custom price set via the
 * dashboard (/api/pricing) is never clobbered. Idempotent: once a row is 0.25
 * it no longer matches '3'.
 */
function migratePricingV58FlashLiteDefault(db: Database.Database) {
  db.prepare("UPDATE settings SET value = '0.25' WHERE key = 'default_price_input_per_1m'  AND value = '3'").run();
  db.prepare("UPDATE settings SET value = '1.50' WHERE key = 'default_price_output_per_1m' AND value = '15'").run();
}

/**
 * V59 (June 2026): two new free-capacity sources (ported from upstream
 * tashfeenahmed/freellmapi, live-probed there 2026-06).
 *
 *  - Kilo Gateway (`kilo`, KEYLESS): OpenAI-compatible aggregator, anonymous
 *    free tier shared 200 req/hr per IP across all :free routes. Per-model rate
 *    limits left NULL on purpose — the budget is per-IP, so we lean on Kilo's
 *    own 429s + the cascade. requiresApiKey=false (providers/index.ts) → router
 *    synthesizes a key=0 row. Prompts logged for training → overflow capacity,
 *    not sensitive payloads.
 *  - Gemma 4 on Google AI Studio (`google`): reachable with the EXISTING Gemini
 *    key (same generateContent endpoint). 15 RPM / 1000 RPD / 250K TPM, ~30M/mo.
 *
 * json-mode left OFF on all six until the deep-test verifies strict JSON; they
 * still serve the plain-text + auto-route chain. Idempotent (INSERT OR IGNORE +
 * generic fallback backfill); applyQualityOrder (V57, runs last) re-sorts them
 * by measured health once traffic arrives.
 */
function migrateModelsV59KiloGemma4(db: Database.Database) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, modality, supports_json_mode, is_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'text', 0, 0)
  `);
  // [platform, model_id, display, intel, speed, size, rpm, rpd, tpm, tpd, budget, ctx]
  // Kilo — keyless, 200 req/hr per IP (per-model limits null on purpose).
  ins.run('kilo', 'poolside/laguna-m.1:free',                'Poolside Laguna M.1 (Kilo)',    13, 8, 'Large',  null, null, null, null, 'free · 200/hr per IP',         262144);
  ins.run('kilo', 'poolside/laguna-xs.2:free',               'Poolside Laguna XS.2 (Kilo)',   16, 4, 'Medium', null, null, null, null, 'free · 200/hr per IP',         262144);
  ins.run('kilo', 'nvidia/nemotron-3-super-120b-a12b:free',  'Nemotron 3 Super 120B (Kilo)',  12, 5, 'Large',  null, null, null, null, 'free · 200/hr per IP (trial)', 1000000);
  ins.run('kilo', 'stepfun/step-3.7-flash:free',             'StepFun Step 3.7 Flash (Kilo)', 14, 3, 'Medium', null, null, null, null, 'free · 200/hr per IP',         262144);
  // Gemma 4 — Google AI Studio, existing Gemini key.
  ins.run('google', 'gemma-4-31b-it',     'Gemma 4 31B IT (Google)', 19, 4, 'Large', 15, 1000, 250000, null, '~30M', 32768);
  ins.run('google', 'gemma-4-26b-a4b-it', 'Gemma 4 26B IT (Google)', 20, 4, 'Large', 15, 1000, 250000, null, '~30M', 32768);
  // Deep-test (2026-06): Gemma 4 on AI Studio emits an English <think> reasoning
  // trace by default — even on "say hello" — burning the token budget on
  // English thinking. Bad for a Turkish chatbot. Mark is_reasoning=1 so the
  // default auto-route (+ askpusulasi alias) excludes them; still reachable via
  // explicit pin or extra.allow_reasoning.
  db.prepare("UPDATE models SET is_reasoning = 1 WHERE platform='google' AND model_id IN ('gemma-4-31b-it','gemma-4-26b-a4b-it')").run();

  // Wire any new enabled rows into fallback_config (generic, all platforms).
  const apply = db.transaction(() => {
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.enabled = 1
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxP = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxP + i + 1);
    }
  });
  apply();
}

/**
 * V56 — per-client-key, per-end-user spend limit table.
 */
function migrateEndUserLimitsV56(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS end_user_limits (
      client_key_id INTEGER NOT NULL,
      end_user_id   TEXT    NOT NULL,
      daily_micro   INTEGER,
      weekly_micro  INTEGER,
      monthly_micro INTEGER,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (client_key_id, end_user_id)
    )
  `);
}

/**
 * V57 — balanced, health-aware fallback re-rank.
 *
 * The old V38 score weighted intelligence_rank ×6, which floated slow frontier
 * models (480B/120B, ~33s latency) and even dead/decommissioned models (still
 * carrying intelligence_rank=1) to the top of the chain. Production: 72% of
 * traffic funnelled into a few slow NVIDIA models, "operation aborted" the #1
 * error, ~68% overall success.
 *
 * qualityRank V57 caps intelligence and folds in MEASURED 7-day success rate +
 * average latency from the requests table. This migration just re-runs
 * applyQualityOrder so the rebalanced order takes effect immediately on deploy
 * — and again on every boot, refreshing the order from recent health data.
 *
 * No models are disabled: flapping free-tier models (OpenRouter :free pool,
 * Cerebras free tier) are demoted by their low measured success rate, not
 * removed, so they still serve as last-resort capacity when idle.
 */
function migrateModelsV57BalancedRerank(db: Database.Database) {
  // NVIDIA's phi-4-multimodal endpoint returns 400 Bad Request on
  // response_format:json_object despite the catalog flagging it json-capable.
  // Under burst it became a cascade SINK (a 400 is non-retryable → the whole
  // request 502'd on it). Drop the bad flag so json-mode routing never picks
  // it; vision_capable stays 1. Idempotent.
  db.prepare(`UPDATE models SET supports_json_mode = 0
              WHERE platform='nvidia' AND model_id='microsoft/phi-4-multimodal-instruct'`).run();
  applyQualityOrder(db);
}

/**
 * V49 — encrypt-and-store the plain key so the operator can re-view it later.
 *
 * Original V44 only stored sha256(plain) so a DB leak could not reveal the
 * key. That was safer, but UX-hostile: if the operator misses the one-shot
 * reveal modal, the key is gone and they have to mint a new one (and rotate
 * every project that pinned it).
 *
 * Add the same AES-256-GCM ciphertext columns the upstream `api_keys` table
 * already uses. ENCRYPTION_KEY only lives in .env so the risk profile is the
 * same as the existing provider-key table. Existing rows have NULL cipher;
 * id=1 ("Default") is back-filled from settings.unified_api_key since that
 * value is already stored in plain there.
 */
function migrateClientKeysV49Reveal(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(client_keys)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'encrypted_key')) {
    db.exec(`
      ALTER TABLE client_keys ADD COLUMN encrypted_key TEXT;
      ALTER TABLE client_keys ADD COLUMN iv TEXT;
      ALTER TABLE client_keys ADD COLUMN auth_tag TEXT;
    `);
  }
  // Back-fill id=1 from settings.unified_api_key when we can (deferred import
  // would be cleaner; inline require keeps the helper self-contained).
  const row = db.prepare('SELECT id, encrypted_key FROM client_keys WHERE id = 1').get() as
    { id: number; encrypted_key: string | null } | undefined;
  if (row && !row.encrypted_key) {
    const unified = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as
      { value: string } | undefined;
    if (unified?.value) {
      const enc = encrypt(unified.value);
      db.prepare(`
        UPDATE client_keys SET encrypted_key = ?, iv = ?, auth_tag = ? WHERE id = 1
      `).run(enc.encrypted, enc.iv, enc.authTag);
    }
  }
}

// ----- Client API key helpers --------------------------------------------

export interface ClientKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
}

export interface ClientKeyAuth {
  id: number;
  name: string;
}

/**
 * Resolve a Bearer token to a client_key row.
 *
 * Returns null on unknown / disabled key. Uses SHA-256 (constant-length output
 * → constant-time string compare via timingSafeEqual). Updates last_used_at
 * out-of-band at most once per minute to keep hot-path writes cheap.
 */
const lastUsedUpdateAt = new Map<number, number>();
export function authenticateApiKey(token: string | undefined): ClientKeyAuth | null {
  if (!token) return null;
  const db = getDb();
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(
    "SELECT id, name FROM client_keys WHERE key_hash = ? AND enabled = 1 AND deleted_at IS NULL",
  ).get(hash) as ClientKeyAuth | undefined;
  if (!row) return null;
  const now = Date.now();
  const prev = lastUsedUpdateAt.get(row.id) ?? 0;
  if (now - prev > 60_000) {
    lastUsedUpdateAt.set(row.id, now);
    try {
      db.prepare("UPDATE client_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    } catch { /* best-effort */ }
  }
  return row;
}

export function listClientKeys(): ClientKeyRow[] {
  return getDb().prepare(`
    SELECT id, name, key_prefix, enabled, created_at, last_used_at
    FROM client_keys
    WHERE deleted_at IS NULL
    ORDER BY id ASC
  `).all() as ClientKeyRow[];
}

export function createClientKey(name: string): { row: ClientKeyRow; plainKey: string } {
  const db = getDb();
  const plainKey = `myllm-${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(plainKey).digest('hex');
  const prefix = plainKey.slice(0, 16);
  // Store both: hash for constant-time auth lookup, AES-256-GCM ciphertext so
  // the operator can re-reveal the plain value later (V49). Cipher is opt-out
  // — if encryption fails for any reason we still store the row (auth keeps
  // working off the hash); reveal will just refuse with 410.
  let encrypted: string | null = null;
  let iv: string | null = null;
  let authTag: string | null = null;
  try {
    const enc = encrypt(plainKey);
    encrypted = enc.encrypted; iv = enc.iv; authTag = enc.authTag;
  } catch { /* leave nulls — reveal becomes unavailable for this row */ }
  const result = db.prepare(`
    INSERT INTO client_keys (name, key_hash, key_prefix, enabled, encrypted_key, iv, auth_tag)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(name, hash, prefix, encrypted, iv, authTag);
  const row = db.prepare(`
    SELECT id, name, key_prefix, enabled, created_at, last_used_at
    FROM client_keys WHERE id = ?
  `).get(result.lastInsertRowid) as ClientKeyRow;
  return { row, plainKey };
}

/**
 * Decrypt and return the plain key value for a row. Returns null when the
 * row is missing OR when it was created before V49 (encrypted_key=NULL); in
 * that case the operator must regenerate the key.
 */
export function revealClientKey(id: number): string | null {
  const row = getDb().prepare(`
    SELECT encrypted_key, iv, auth_tag FROM client_keys WHERE id = ?
  `).get(id) as { encrypted_key: string | null; iv: string | null; auth_tag: string | null } | undefined;
  if (!row || !row.encrypted_key || !row.iv || !row.auth_tag) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

export function updateClientKey(id: number, patch: { name?: string; enabled?: boolean }): ClientKeyRow | null {
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
  if (sets.length === 0) return getClientKey(id);
  args.push(id);
  db.prepare(`UPDATE client_keys SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getClientKey(id);
}

export function getClientKey(id: number): ClientKeyRow | null {
  return (getDb().prepare(`
    SELECT id, name, key_prefix, enabled, created_at, last_used_at
    FROM client_keys WHERE id = ? AND deleted_at IS NULL
  `).get(id) as ClientKeyRow | undefined) ?? null;
}

export function deleteClientKey(id: number): boolean {
  // id=1 ("Default") is protected — a slip in the UI shouldn't brick the
  // unified token every project pinned. Soft-delete (V50): set deleted_at
  // so the analytics by-key JOIN keeps resolving the row's name, and
  // attribution for past requests stays intact.
  if (id === 1) return false;
  const r = getDb().prepare(`
    UPDATE client_keys SET deleted_at = datetime('now'), enabled = 0
     WHERE id = ? AND deleted_at IS NULL
  `).run(id);
  return r.changes > 0;
}
