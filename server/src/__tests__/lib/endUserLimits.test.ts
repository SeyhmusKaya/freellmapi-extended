import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  getEndUserSpend,
  checkEndUserLimit,
  setEndUserLimits,
  getEndUserLimits,
  getWindowStarts,
} from '../../lib/endUserLimits.js';

describe('endUserLimits', () => {
  let clientKeyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM end_user_limits').run();
    // Use the seeded Default client_key (id=1)
    clientKeyId = 1;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function insertRequest(opts: {
    endUserId: string;
    costMicro: number;
    status?: string;
    createdAt?: string; // UTC "YYYY-MM-DD HH:MM:SS"
  }) {
    const db = getDb();
    const { dayStart } = getWindowStarts();
    const createdAt = opts.createdAt ?? dayStart; // default: today
    db.prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms,
         error, client_key_id, end_user_id, cost_micro, created_at)
      VALUES ('groq','llama-3.3-70b-versatile',?,0,0,0,NULL,?,?,?,?)
    `).run(opts.status ?? 'success', clientKeyId, opts.endUserId, opts.costMicro, createdAt);
  }

  // ---------------------------------------------------------------------------
  // getEndUserSpend
  // ---------------------------------------------------------------------------
  it('returns zeros when no requests', () => {
    const spend = getEndUserSpend(clientKeyId, 'user-1');
    expect(spend.daily_micro).toBe(0);
    expect(spend.weekly_micro).toBe(0);
    expect(spend.monthly_micro).toBe(0);
    expect(spend.total_micro).toBe(0);
  });

  it('counts successful requests in daily window', () => {
    insertRequest({ endUserId: 'user-1', costMicro: 5000 });
    insertRequest({ endUserId: 'user-1', costMicro: 3000 });
    const spend = getEndUserSpend(clientKeyId, 'user-1');
    expect(spend.daily_micro).toBe(8000);
    expect(spend.total_micro).toBe(8000);
  });

  it('excludes error requests from spend', () => {
    insertRequest({ endUserId: 'user-2', costMicro: 9999, status: 'error' });
    const spend = getEndUserSpend(clientKeyId, 'user-2');
    expect(spend.daily_micro).toBe(0);
    expect(spend.total_micro).toBe(0);
  });

  it('excludes requests from other end users', () => {
    insertRequest({ endUserId: 'user-A', costMicro: 10000 });
    insertRequest({ endUserId: 'user-B', costMicro: 20000 });
    expect(getEndUserSpend(clientKeyId, 'user-A').total_micro).toBe(10000);
    expect(getEndUserSpend(clientKeyId, 'user-B').total_micro).toBe(20000);
  });

  it('counts old requests in total but not in daily', () => {
    // Insert one request from 10 days ago
    const oldDate = new Date(Date.now() - 10 * 86400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const oldStr = `${oldDate.getUTCFullYear()}-${pad(oldDate.getUTCMonth() + 1)}-${pad(oldDate.getUTCDate())} 00:00:01`;
    insertRequest({ endUserId: 'user-3', costMicro: 50000, createdAt: oldStr });
    // Insert one request from today
    insertRequest({ endUserId: 'user-3', costMicro: 1000 });

    const spend = getEndUserSpend(clientKeyId, 'user-3');
    expect(spend.total_micro).toBe(51000);
    expect(spend.daily_micro).toBe(1000);
    // Old request is older than 7 days so weekly should also be just 1000
    expect(spend.weekly_micro).toBe(1000);
  });

  // ---------------------------------------------------------------------------
  // checkEndUserLimit
  // ---------------------------------------------------------------------------
  it('allows when endUserId is null', () => {
    const result = checkEndUserLimit(clientKeyId, null);
    expect(result.allowed).toBe(true);
  });

  it('allows when no limit row exists', () => {
    insertRequest({ endUserId: 'user-no-limit', costMicro: 1_000_000 });
    const result = checkEndUserLimit(clientKeyId, 'user-no-limit');
    expect(result.allowed).toBe(true);
  });

  it('allows when spend is below limit', () => {
    insertRequest({ endUserId: 'user-under', costMicro: 5000 });
    setEndUserLimits(clientKeyId, 'user-under', { daily_micro: 100_000 });
    const result = checkEndUserLimit(clientKeyId, 'user-under');
    expect(result.allowed).toBe(true);
  });

  it('blocks when daily spend meets limit', () => {
    insertRequest({ endUserId: 'user-over-daily', costMicro: 10_000 });
    setEndUserLimits(clientKeyId, 'user-over-daily', { daily_micro: 10_000 });
    const result = checkEndUserLimit(clientKeyId, 'user-over-daily');
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toBe('daily');
    expect(result.limitMicro).toBe(10_000);
    expect(result.spentMicro).toBe(10_000);
  });

  it('blocks when monthly spend exceeds limit', () => {
    insertRequest({ endUserId: 'user-over-month', costMicro: 500_000 });
    setEndUserLimits(clientKeyId, 'user-over-month', { monthly_micro: 499_999 });
    const result = checkEndUserLimit(clientKeyId, 'user-over-month');
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toBe('monthly');
  });

  it('checks daily before weekly before monthly', () => {
    insertRequest({ endUserId: 'user-all-over', costMicro: 1000 });
    setEndUserLimits(clientKeyId, 'user-all-over', {
      daily_micro:   500,  // exceeded
      weekly_micro:  500,  // also exceeded
      monthly_micro: 500,  // also exceeded
    });
    const result = checkEndUserLimit(clientKeyId, 'user-all-over');
    // daily is checked first
    expect(result.exceeded).toBe('daily');
  });

  it('skips null limit windows', () => {
    insertRequest({ endUserId: 'user-partial', costMicro: 5000 });
    // Only monthly limit set, daily/weekly are null → no daily/weekly check
    setEndUserLimits(clientKeyId, 'user-partial', { daily_micro: null, weekly_micro: null, monthly_micro: 100_000 });
    const result = checkEndUserLimit(clientKeyId, 'user-partial');
    expect(result.allowed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------
  it('getEndUserLimits returns null when no row', () => {
    expect(getEndUserLimits(clientKeyId, 'no-such-user')).toBeNull();
  });

  it('setEndUserLimits upserts correctly', () => {
    setEndUserLimits(clientKeyId, 'crud-user', { daily_micro: 10_000, weekly_micro: 50_000, monthly_micro: 200_000 });
    const row = getEndUserLimits(clientKeyId, 'crud-user');
    expect(row?.daily_micro).toBe(10_000);
    expect(row?.weekly_micro).toBe(50_000);
    expect(row?.monthly_micro).toBe(200_000);

    // Update
    setEndUserLimits(clientKeyId, 'crud-user', { daily_micro: null, weekly_micro: 60_000, monthly_micro: 200_000 });
    const row2 = getEndUserLimits(clientKeyId, 'crud-user');
    expect(row2?.daily_micro).toBeNull();
    expect(row2?.weekly_micro).toBe(60_000);
  });
});
