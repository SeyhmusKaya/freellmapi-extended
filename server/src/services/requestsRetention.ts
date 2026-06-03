import { getDb } from '../db/index.js';

const RETENTION_DAYS = Number(process.env.MYLLM_REQUESTS_RETENTION_DAYS ?? 60);
const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // every 12 hours
const FIRST_SWEEP_MS = 2 * 60 * 1000;          // first sweep 2 min after boot

/**
 * Retention sweeper for the `requests` log table.
 *
 * Every proxied call writes a row (and cascade attempts write several). The
 * table grows unbounded; analytics only ever queries a bounded time range
 * (24h / 7d / 30d), so rows older than MYLLM_REQUESTS_RETENTION_DAYS
 * (default 60) have no consumer and can be purged. Persisted RPD/TPD counters
 * live in `usage_counters`, not here, so deleting old request rows does not
 * affect rate-limit accounting.
 */
export function startRequestsRetention() {
  function sweep() {
    try {
      const db = getDb();
      const result = db.prepare(`
        DELETE FROM requests
         WHERE created_at < datetime('now', ?)
      `).run(`-${RETENTION_DAYS} days`);
      if (result.changes > 0) console.log(`[Retention] purged ${result.changes} request rows (>${RETENTION_DAYS}d)`);
    } catch (e) {
      console.error('[Retention] requests sweep failed:', e);
    }
  }
  setTimeout(sweep, FIRST_SWEEP_MS);
  setInterval(sweep, SWEEP_INTERVAL_MS);
  console.log(`[Retention] requests scheduler started (retention=${RETENTION_DAYS}d, sweep=${SWEEP_INTERVAL_MS / 3600_000}h)`);
}
