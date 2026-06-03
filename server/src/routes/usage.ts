import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateClient } from '../lib/clientAuth.js';
import {
  getEndUserSpend,
  getEndUserLimits,
  setEndUserLimits,
} from '../lib/endUserLimits.js';

export const usageRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function microToUsd(micro: number | null | undefined): number {
  if (micro == null) return 0;
  return parseFloat((micro / 1_000_000).toFixed(6));
}

function usdToMicro(usd: number | null | undefined): number | null {
  if (usd == null) return null;
  return Math.round(usd * 1_000_000);
}

// ---------------------------------------------------------------------------
// GET /v1/usage?user=<id>&period=day|week|month|all
// POST /v1/usage  { user }
// ---------------------------------------------------------------------------
async function handleSpend(req: Request, res: Response) {
  if (!authenticateClient(req, res)) return;

  const userId: string | undefined =
    (req.method === 'POST' ? req.body?.user : req.query.user) as string | undefined;

  if (!userId || String(userId).trim().length === 0) {
    res.status(400).json({ error: { message: 'Missing required parameter: user', type: 'invalid_request_error' } });
    return;
  }

  const clientKeyId: number = (req as any).clientKeyId;
  const period = req.method === 'GET' ? (req.query.period as string | undefined) : undefined;

  const spend = getEndUserSpend(clientKeyId, String(userId).trim());

  const body: Record<string, any> = { user: userId, currency: 'USD' };

  if (!period || period === 'all') {
    body.daily_usd   = microToUsd(spend.daily_micro);
    body.weekly_usd  = microToUsd(spend.weekly_micro);
    body.monthly_usd = microToUsd(spend.monthly_micro);
    body.total_usd   = microToUsd(spend.total_micro);
  } else if (period === 'day') {
    body.daily_usd = microToUsd(spend.daily_micro);
  } else if (period === 'week') {
    body.weekly_usd = microToUsd(spend.weekly_micro);
  } else if (period === 'month') {
    body.monthly_usd = microToUsd(spend.monthly_micro);
  } else {
    res.status(400).json({ error: { message: 'Invalid period. Use day, week, month, or all.', type: 'invalid_request_error' } });
    return;
  }

  res.json(body);
}

usageRouter.get('/', handleSpend);
usageRouter.post('/', handleSpend);

// ---------------------------------------------------------------------------
// GET /v1/usage/limits?user=<id>
// ---------------------------------------------------------------------------
usageRouter.get('/limits', (req: Request, res: Response) => {
  if (!authenticateClient(req, res)) return;

  const userId = req.query.user as string | undefined;
  if (!userId || String(userId).trim().length === 0) {
    res.status(400).json({ error: { message: 'Missing required parameter: user', type: 'invalid_request_error' } });
    return;
  }

  const clientKeyId: number = (req as any).clientKeyId;
  const limits = getEndUserLimits(clientKeyId, String(userId).trim());

  res.json({
    user: userId,
    currency: 'USD',
    daily_usd:   limits?.daily_micro   != null ? microToUsd(limits.daily_micro)   : null,
    weekly_usd:  limits?.weekly_micro  != null ? microToUsd(limits.weekly_micro)  : null,
    monthly_usd: limits?.monthly_micro != null ? microToUsd(limits.monthly_micro) : null,
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/usage/limits  { user, daily_usd?, weekly_usd?, monthly_usd? }
// ---------------------------------------------------------------------------
usageRouter.put('/limits', (req: Request, res: Response) => {
  if (!authenticateClient(req, res)) return;

  const { user, daily_usd, weekly_usd, monthly_usd } = req.body ?? {};
  if (!user || String(user).trim().length === 0) {
    res.status(400).json({ error: { message: 'Missing required field: user', type: 'invalid_request_error' } });
    return;
  }

  const clientKeyId: number = (req as any).clientKeyId;
  const userId = String(user).trim();

  setEndUserLimits(clientKeyId, userId, {
    daily_micro:   daily_usd   !== undefined ? usdToMicro(daily_usd)   : undefined,
    weekly_micro:  weekly_usd  !== undefined ? usdToMicro(weekly_usd)  : undefined,
    monthly_micro: monthly_usd !== undefined ? usdToMicro(monthly_usd) : undefined,
  });

  const saved = getEndUserLimits(clientKeyId, userId);
  res.json({
    user: userId,
    currency: 'USD',
    daily_usd:   saved?.daily_micro   != null ? microToUsd(saved.daily_micro)   : null,
    weekly_usd:  saved?.weekly_micro  != null ? microToUsd(saved.weekly_micro)  : null,
    monthly_usd: saved?.monthly_micro != null ? microToUsd(saved.monthly_micro) : null,
  });
});
