import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { invalidatePriceCache } from '../lib/pricing.js';

export const pricingRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/pricing  — list all models with effective pricing
// ---------------------------------------------------------------------------
pricingRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const defaults = (() => {
    const get = (key: string, fallback: number): number => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      if (!row) return fallback;
      const n = parseFloat(row.value);
      return isFinite(n) ? n : fallback;
    };
    return {
      input_per_1m:  get('default_price_input_per_1m',  0.25),
      output_per_1m: get('default_price_output_per_1m', 1.50),
      per_call:      get('default_price_per_call',       0.04),
    };
  })();

  const models = db.prepare(`
    SELECT platform, model_id, display_name,
           COALESCE(modality, 'text') AS modality,
           price_input_per_1m, price_output_per_1m, price_per_call
      FROM models
     ORDER BY intelligence_rank, platform, model_id
  `).all() as Array<{
    platform: string;
    model_id: string;
    display_name: string;
    modality: string;
    price_input_per_1m: number | null;
    price_output_per_1m: number | null;
    price_per_call: number | null;
  }>;

  res.json({
    defaults,
    models: models.map(m => ({
      platform:             m.platform,
      model_id:             m.model_id,
      display_name:         m.display_name,
      modality:             m.modality,
      price_input_per_1m:   m.price_input_per_1m  ?? null,
      price_output_per_1m:  m.price_output_per_1m ?? null,
      price_per_call:       m.price_per_call       ?? null,
      // Effective = model-level override OR global default
      effective_input_per_1m:  m.price_input_per_1m  ?? defaults.input_per_1m,
      effective_output_per_1m: m.price_output_per_1m ?? defaults.output_per_1m,
      effective_per_call:      m.price_per_call       ?? defaults.per_call,
    })),
  });
});

// ---------------------------------------------------------------------------
// PUT /api/pricing/defaults  { input_per_1m?, output_per_1m?, per_call? }
// ---------------------------------------------------------------------------
pricingRouter.put('/defaults', (req: Request, res: Response) => {
  const db = getDb();
  const { input_per_1m, output_per_1m, per_call } = req.body ?? {};

  const set = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const update = db.transaction(() => {
    if (input_per_1m  != null) set.run('default_price_input_per_1m',  String(input_per_1m));
    if (output_per_1m != null) set.run('default_price_output_per_1m', String(output_per_1m));
    if (per_call      != null) set.run('default_price_per_call',       String(per_call));
  });
  update();
  invalidatePriceCache();

  const get = (key: string, fallback: number): number => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return fallback;
    const n = parseFloat(row.value);
    return isFinite(n) ? n : fallback;
  };

  res.json({
    input_per_1m:  get('default_price_input_per_1m',  3),
    output_per_1m: get('default_price_output_per_1m', 15),
    per_call:      get('default_price_per_call',       0.04),
  });
});

// ---------------------------------------------------------------------------
// PUT /api/pricing/model  { platform, model_id, price_input_per_1m?, price_output_per_1m?, price_per_call? }
// null = reset to default
// ---------------------------------------------------------------------------
pricingRouter.put('/model', (req: Request, res: Response) => {
  const { platform, model_id, price_input_per_1m, price_output_per_1m, price_per_call } = req.body ?? {};

  if (!platform || !model_id) {
    res.status(400).json({ error: { message: 'platform and model_id are required', type: 'invalid_request_error' } });
    return;
  }

  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];

  if (price_input_per_1m  !== undefined) { sets.push('price_input_per_1m  = ?'); args.push(price_input_per_1m  ?? null); }
  if (price_output_per_1m !== undefined) { sets.push('price_output_per_1m = ?'); args.push(price_output_per_1m ?? null); }
  if (price_per_call      !== undefined) { sets.push('price_per_call      = ?'); args.push(price_per_call      ?? null); }

  if (sets.length === 0) {
    res.status(400).json({ error: { message: 'No pricing fields provided', type: 'invalid_request_error' } });
    return;
  }

  args.push(platform, model_id);
  const result = db.prepare(
    `UPDATE models SET ${sets.join(', ')} WHERE platform = ? AND model_id = ?`
  ).run(...args);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Model not found', type: 'not_found' } });
    return;
  }

  invalidatePriceCache();

  const row = db.prepare(
    'SELECT platform, model_id, price_input_per_1m, price_output_per_1m, price_per_call FROM models WHERE platform = ? AND model_id = ?'
  ).get(platform, model_id) as {
    platform: string; model_id: string;
    price_input_per_1m: number | null;
    price_output_per_1m: number | null;
    price_per_call: number | null;
  };

  res.json(row);
});
