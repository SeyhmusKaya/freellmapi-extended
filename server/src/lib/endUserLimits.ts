import { getDb } from '../db/index.js';

// ---------------------------------------------------------------------------
// Window start helpers — UTC, "YYYY-MM-DD HH:MM:SS" format for comparison
// with requests.created_at (which uses datetime('now') = UTC).
// ---------------------------------------------------------------------------
export function getWindowStarts(): {
  dayStart: string;
  weekStart: string;
  monthStart: string;
} {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  // Today 00:00:00 UTC
  const dayStart = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} 00:00:00`;

  // ISO Monday 00:00:00 UTC (getUTCDay: 0=Sun, 1=Mon…6=Sat)
  const dow = now.getUTCDay(); // 0=Sun
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToMon));
  const weekStart = `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())} 00:00:00`;

  // 1st of this month 00:00:00 UTC
  const monthStart = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01 00:00:00`;

  return { dayStart, weekStart, monthStart };
}

// ---------------------------------------------------------------------------
// Spend queries
// ---------------------------------------------------------------------------
export function getEndUserSpend(
  clientKeyId: number,
  endUserId: string,
): { daily_micro: number; weekly_micro: number; monthly_micro: number; total_micro: number } {
  const db = getDb();
  const { dayStart, weekStart, monthStart } = getWindowStarts();

  const sumSince = (since: string): number => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_micro), 0) AS s
        FROM requests
       WHERE client_key_id = ?
         AND end_user_id   = ?
         AND status        = 'success'
         AND created_at   >= ?
    `).get(clientKeyId, endUserId, since) as { s: number };
    return row.s;
  };

  const total = (db.prepare(`
    SELECT COALESCE(SUM(cost_micro), 0) AS s
      FROM requests
     WHERE client_key_id = ?
       AND end_user_id   = ?
       AND status        = 'success'
  `).get(clientKeyId, endUserId) as { s: number }).s;

  return {
    daily_micro:   sumSince(dayStart),
    weekly_micro:  sumSince(weekStart),
    monthly_micro: sumSince(monthStart),
    total_micro:   total,
  };
}

// ---------------------------------------------------------------------------
// Limit check
// ---------------------------------------------------------------------------
export function checkEndUserLimit(
  clientKeyId: number,
  endUserId: string | null,
): { allowed: boolean; exceeded?: 'daily' | 'weekly' | 'monthly'; limitMicro?: number; spentMicro?: number } {
  if (!endUserId) return { allowed: true };

  try {
    const db = getDb();
    const limitRow = db.prepare(`
      SELECT daily_micro, weekly_micro, monthly_micro
        FROM end_user_limits
       WHERE client_key_id = ? AND end_user_id = ?
    `).get(clientKeyId, endUserId) as {
      daily_micro: number | null;
      weekly_micro: number | null;
      monthly_micro: number | null;
    } | undefined;

    if (!limitRow) return { allowed: true };

    const { dayStart, weekStart, monthStart } = getWindowStarts();

    const sumSince = (since: string): number => {
      const row = db.prepare(`
        SELECT COALESCE(SUM(cost_micro), 0) AS s
          FROM requests
         WHERE client_key_id = ?
           AND end_user_id   = ?
           AND status        = 'success'
           AND created_at   >= ?
      `).get(clientKeyId, endUserId, since) as { s: number };
      return row.s;
    };

    // Check only defined (non-null) windows
    if (limitRow.daily_micro != null) {
      const spent = sumSince(dayStart);
      if (spent >= limitRow.daily_micro) {
        return { allowed: false, exceeded: 'daily', limitMicro: limitRow.daily_micro, spentMicro: spent };
      }
    }
    if (limitRow.weekly_micro != null) {
      const spent = sumSince(weekStart);
      if (spent >= limitRow.weekly_micro) {
        return { allowed: false, exceeded: 'weekly', limitMicro: limitRow.weekly_micro, spentMicro: spent };
      }
    }
    if (limitRow.monthly_micro != null) {
      const spent = sumSince(monthStart);
      if (spent >= limitRow.monthly_micro) {
        return { allowed: false, exceeded: 'monthly', limitMicro: limitRow.monthly_micro, spentMicro: spent };
      }
    }

    return { allowed: true };
  } catch {
    // Never block a request due to an internal limit-check error.
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
export function getEndUserLimits(
  clientKeyId: number,
  endUserId: string,
): { daily_micro: number | null; weekly_micro: number | null; monthly_micro: number | null } | null {
  const row = getDb().prepare(`
    SELECT daily_micro, weekly_micro, monthly_micro
      FROM end_user_limits
     WHERE client_key_id = ? AND end_user_id = ?
  `).get(clientKeyId, endUserId) as {
    daily_micro: number | null;
    weekly_micro: number | null;
    monthly_micro: number | null;
  } | undefined;
  return row ?? null;
}

export function setEndUserLimits(
  clientKeyId: number,
  endUserId: string,
  limits: { daily_micro?: number | null; weekly_micro?: number | null; monthly_micro?: number | null },
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO end_user_limits (client_key_id, end_user_id, daily_micro, weekly_micro, monthly_micro, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (client_key_id, end_user_id) DO UPDATE SET
      daily_micro   = excluded.daily_micro,
      weekly_micro  = excluded.weekly_micro,
      monthly_micro = excluded.monthly_micro,
      updated_at    = datetime('now')
  `).run(
    clientKeyId,
    endUserId,
    limits.daily_micro   ?? null,
    limits.weekly_micro  ?? null,
    limits.monthly_micro ?? null,
  );
}
