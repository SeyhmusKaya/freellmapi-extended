import crypto from 'crypto';
import { getDb, getUnifiedApiKey } from '../db/index.js';

const ATTEMPT_DELAYS_MS = [0, 5_000, 30_000, 300_000]; // attempt 1 immediate, then 5s, 30s, 5min
const MAX_ATTEMPTS = Number(process.env.MYLLM_BATCH_CALLBACK_ATTEMPTS ?? 3);
const REQUEST_TIMEOUT_MS = 10_000;

interface BatchRow {
  id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  metadata: string | null;
  callback_url: string | null;
  callback_status: string | null;
  callback_attempts: number;
  finished_at: string | null;
}

/**
 * Webhook delivery for finalized batches with a callback_url. HMAC-SHA256
 * signature over the raw JSON body, signed with the unified API key. Header:
 *   X-MyLLM-Signature: sha256=<hex>
 *
 * Up to MAX_ATTEMPTS deliveries with backoff 5s, 30s, 5min. callback_status
 * goes: NULL → pending → sent / failed.
 */
export class WebhookDispatcher {
  private running = false;
  private inflight = new Set<string>();

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[Webhook] dispatcher starting (maxAttempts=${MAX_ATTEMPTS})`);
    this.loop().catch(err => console.error('[Webhook] dispatcher crashed:', err));
  }

  stop() { this.running = false; }

  private async loop() {
    while (this.running) {
      const batch = this.pickPendingWebhook();
      if (!batch) {
        await sleep(2000);
        continue;
      }
      this.deliver(batch).catch(err => console.error('[Webhook] deliver error:', err));
    }
  }

  private pickPendingWebhook(): BatchRow | null {
    const db = getDb();
    // Finalized batch with a callback_url that hasn't been sent yet.
    // We mark callback_status='pending' on finalize (handled here too as a
    // lazy upgrade) so we can pick deterministically.
    db.prepare(`
      UPDATE batches
         SET callback_status='pending'
       WHERE callback_url IS NOT NULL
         AND callback_status IS NULL
         AND status IN ('completed','cancelled')
    `).run();

    const row = db.prepare(`
      SELECT id, status, total, completed, failed, metadata, callback_url,
             callback_status, callback_attempts, finished_at
        FROM batches
       WHERE callback_url IS NOT NULL
         AND callback_status='pending'
         AND callback_attempts < ?
       ORDER BY finished_at ASC
       LIMIT 1
    `).get(MAX_ATTEMPTS) as BatchRow | undefined;

    if (!row) return null;
    if (this.inflight.has(row.id)) return null;
    return row;
  }

  private async deliver(batch: BatchRow) {
    this.inflight.add(batch.id);
    const db = getDb();
    try {
      const attempt = batch.callback_attempts; // already-completed attempts
      const delay = ATTEMPT_DELAYS_MS[Math.min(attempt, ATTEMPT_DELAYS_MS.length - 1)];
      if (delay > 0) await sleep(delay);

      let meta = batch.metadata ? JSON.parse(batch.metadata) : null;
      if (meta && typeof meta === 'object') {
        const { __idem_hash, ...rest } = meta;
        meta = Object.keys(rest).length ? rest : null;
      }
      const baseUrl = (process.env.MYLLM_PUBLIC_URL ?? 'https://myapi.example.com').replace(/\/$/, '');

      const payload = {
        id: batch.id,
        object: 'batch.event',
        status: batch.status,
        request_counts: { total: batch.total, completed: batch.completed, failed: batch.failed },
        finished_at: batch.finished_at,
        metadata: meta,
        results_url: `${baseUrl}/v1/batches/${batch.id}/results`,
      };
      const body = JSON.stringify(payload);
      const key = getUnifiedApiKey();
      const sig = 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex');

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let ok = false;
      let errMsg: string | null = null;
      try {
        const res = await fetch(batch.callback_url!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-MyLLM-Signature': sig },
          body,
          signal: controller.signal,
        });
        ok = res.status >= 200 && res.status < 300;
        if (!ok) errMsg = `HTTP ${res.status}`;
      } catch (e: any) {
        errMsg = e?.message ?? 'unknown';
      } finally {
        clearTimeout(t);
      }

      const newAttempts = attempt + 1;
      if (ok) {
        db.prepare(`UPDATE batches SET callback_status='sent', callback_attempts=? WHERE id=?`).run(newAttempts, batch.id);
        console.log(`[Webhook] ${batch.id} delivered (attempt ${newAttempts})`);
      } else if (newAttempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE batches SET callback_status='failed', callback_attempts=? WHERE id=?`).run(newAttempts, batch.id);
        console.warn(`[Webhook] ${batch.id} exhausted (${errMsg})`);
      } else {
        db.prepare(`UPDATE batches SET callback_attempts=? WHERE id=?`).run(newAttempts, batch.id);
        console.log(`[Webhook] ${batch.id} attempt ${newAttempts}/${MAX_ATTEMPTS} failed (${errMsg}), will retry`);
      }
    } finally {
      this.inflight.delete(batch.id);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let singleton: WebhookDispatcher | null = null;
export function getWebhookDispatcher(): WebhookDispatcher {
  if (!singleton) singleton = new WebhookDispatcher();
  return singleton;
}
