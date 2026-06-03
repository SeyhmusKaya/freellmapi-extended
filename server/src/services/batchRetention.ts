import { getDb } from '../db/index.js';

const RETENTION_DAYS = Number(process.env.MYLLM_BATCH_RETENTION_DAYS ?? 7);
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const FIRST_SWEEP_MS = 60 * 1000;             // first sweep 1 min after boot

/**
 * Cron-style retention sweeper. Deletes finalized batches older than
 * MYLLM_BATCH_RETENTION_DAYS (default 7). FK CASCADE handles batch_items.
 * Active batches (queued/processing) are never deleted regardless of age.
 */
export function startBatchRetention() {
  function sweep() {
    try {
      const db = getDb();
      const result = db.prepare(`
        DELETE FROM batches
         WHERE finished_at IS NOT NULL
           AND finished_at < datetime('now', ?)
      `).run(`-${RETENTION_DAYS} days`);
      if (result.changes > 0) console.log(`[Retention] purged ${result.changes} batches (>${RETENTION_DAYS}d)`);
    } catch (e) {
      console.error('[Retention] sweep failed:', e);
    }
  }
  setTimeout(sweep, FIRST_SWEEP_MS);
  setInterval(sweep, SWEEP_INTERVAL_MS);
  console.log(`[Retention] scheduler started (retention=${RETENTION_DAYS}d, sweep=${SWEEP_INTERVAL_MS / 3600_000}h)`);
}
