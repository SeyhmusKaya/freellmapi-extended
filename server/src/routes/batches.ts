import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { authenticateClient } from '../lib/clientAuth.js';
import { batchId as makeBatchId } from '../lib/ulid.js';
import { chatCompletionSchema } from '../lib/runChatCompletion.js';
import { embeddingSchema } from '../lib/runEmbedding.js';

function hashBody(body: any): string {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export const batchesRouter = Router();

// ---- Config (env override) ----

const MAX_ITEMS = Number(process.env.MYLLM_BATCH_MAX_ITEMS ?? 1000);
const MAX_BYTES = Number(process.env.MYLLM_BATCH_MAX_BYTES ?? 5 * 1024 * 1024);
const MAX_ACTIVE = Number(process.env.MYLLM_BATCH_MAX_ACTIVE ?? 10);
const MAX_CUSTOM_ID_LEN = 256;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---- Auth (Bearer client key) ----

function authenticate(req: Request, res: Response): boolean {
  return authenticateClient(req, res);
}

// ---- Schemas ----

const priorityMap = { low: 1, normal: 2, high: 3 } as const;

// Per-item schema. OpenAI batch shape uses `url` field; we accept either
// /v1/chat/completions (default for backwards compatibility — pre-Faz2
// callers omitted the field) or /v1/embeddings. The body shape is validated
// based on url via refine() because zod discriminatedUnion can't combine
// optional + default on the discriminator field.
const batchItemSchema = z.object({
  url: z.enum(['/v1/chat/completions', '/v1/embeddings']).optional().default('/v1/chat/completions'),
  custom_id: z.string().min(1).max(MAX_CUSTOM_ID_LEN),
  body: z.any(),
}).superRefine((val, ctx) => {
  if (val.url === '/v1/embeddings') {
    const r = embeddingSchema.safeParse(val.body);
    if (!r.success) {
      for (const issue of r.error.errors) ctx.addIssue({ ...issue, path: ['body', ...(issue.path ?? [])] });
    }
  } else {
    const r = chatCompletionSchema.safeParse(val.body);
    if (!r.success) {
      for (const issue of r.error.errors) ctx.addIssue({ ...issue, path: ['body', ...(issue.path ?? [])] });
    }
  }
});

const createBatchSchema = z.object({
  items: z.array(batchItemSchema).min(1).max(MAX_ITEMS),
  metadata: z.record(z.string(), z.unknown()).optional(),
  callback_url: z.string().url().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
});

// ---- Helpers ----

interface BatchRow {
  id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  priority: number;
  metadata: string | null;
  callback_url: string | null;
  callback_status: string | null;
  callback_attempts: number;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const PRIORITY_NAME: Record<number, string> = { 1: 'low', 2: 'normal', 3: 'high' };

function serializeBatch(row: BatchRow): any {
  let meta = row.metadata ? JSON.parse(row.metadata) : null;
  if (meta && typeof meta === 'object') {
    const { __idem_hash, ...rest } = meta;
    meta = Object.keys(rest).length ? rest : null;
  }
  return {
    id: row.id,
    object: 'batch',
    status: row.status,
    request_counts: {
      total: row.total,
      completed: row.completed,
      failed: row.failed,
    },
    priority: PRIORITY_NAME[row.priority] ?? 'normal',
    metadata: meta,
    callback_url: row.callback_url,
    // Webhook delivery state — null when no callback_url was set.
    callback_status: row.callback_status,
    callback_attempts: row.callback_attempts,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

// ---- POST /v1/batches ----

batchesRouter.post('/', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const payloadSize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
  if (payloadSize > MAX_BYTES) {
    res.status(400).json({ error: { message: `payload exceeds ${MAX_BYTES} bytes`, type: 'invalid_request', code: 'payload_too_large' } });
    return;
  }

  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => `${e.path.join('.')} ${e.message}`).join('; ')}`,
        type: 'invalid_request',
      },
    });
    return;
  }

  const { items, metadata, callback_url, priority } = parsed.data;

  // custom_id uniqueness within batch
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.custom_id)) {
      res.status(400).json({ error: { message: `duplicate custom_id: ${it.custom_id}`, type: 'invalid_request', code: 'duplicate_custom_id' } });
      return;
    }
    seen.add(it.custom_id);
  }

  if (metadata && Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 2048) {
    res.status(400).json({ error: { message: 'metadata exceeds 2KB', type: 'invalid_request', code: 'metadata_too_large' } });
    return;
  }

  const db = getDb();

  // Cap active batches per key (single-tenant: applies to the unified key)
  const active = db.prepare(`SELECT COUNT(*) AS cnt FROM batches WHERE status IN ('queued','processing')`).get() as { cnt: number };
  if (active.cnt >= MAX_ACTIVE) {
    res.status(429).json({ error: { message: `too many active batches (max ${MAX_ACTIVE})`, type: 'rate_limit_error', code: 'too_many_active_batches' } });
    return;
  }

  // Idempotency-Key: same key within 24h window returns existing batch
  // (if same body hash) or 409 (if mismatch). Body hash is stored in metadata
  // so a request-doppelganger can be reliably detected.
  const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
  const bodyHash = hashBody({ items, metadata, callback_url, priority });

  if (idempotencyKey) {
    const existing = db.prepare(`
      SELECT * FROM batches WHERE idempotency_key = ?
        AND created_at > datetime('now', '-24 hours')
    `).get(idempotencyKey) as BatchRow & { idempotency_body_hash?: string } | undefined;
    if (existing) {
      const stored = existing.metadata ? JSON.parse(existing.metadata) : {};
      if (stored.__idem_hash !== bodyHash) {
        res.status(409).json({ error: { message: 'idempotency_key collision with different body', type: 'invalid_request', code: 'idempotency_key_conflict' } });
        return;
      }
      res.status(200).json(serializeBatch(existing));
      return;
    }
  }

  const id = makeBatchId();
  const pri = priorityMap[priority ?? 'normal'];

  // We stash the body hash inside metadata under __idem_hash so collision
  // detection survives without a separate column.
  const storedMetadata: Record<string, any> = { ...(metadata ?? {}) };
  if (idempotencyKey) storedMetadata.__idem_hash = bodyHash;

  const insertBatch = db.prepare(`
    INSERT INTO batches (id, status, total, priority, metadata, callback_url, idempotency_key)
    VALUES (?, 'queued', ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO batch_items (batch_id, position, custom_id, request_body, endpoint)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertBatch.run(
      id,
      items.length,
      pri,
      JSON.stringify(storedMetadata),
      callback_url ?? null,
      idempotencyKey,
    );
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // stream:false is a chat-only field; embedding bodies pass through unchanged
      const body = item.url === '/v1/embeddings' ? item.body : { ...item.body, stream: false };
      insertItem.run(id, i, item.custom_id, JSON.stringify(body), item.url);
    }
  });
  tx();

  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow;
  res.status(201).json(serializeBatch(row));
});

// ---- GET /v1/batches ----

export function listBatchesHandler(req: Request, res: Response) {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

  const db = getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (statusFilter) { where.push('status = ?'); params.push(statusFilter); }
  if (cursor)       { where.push('id < ?');     params.push(cursor); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`SELECT * FROM batches ${whereClause} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1) as BatchRow[];
  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map(serializeBatch);
  res.json({ data, next_cursor: hasMore ? rows[limit - 1].id : null });
}

batchesRouter.get('/', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  listBatchesHandler(req, res);
});

// ---- GET /v1/batches/:id ----

export function getBatchHandler(req: Request, res: Response) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id) as BatchRow | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'batch not found', type: 'invalid_request' } });
    return;
  }
  res.json(serializeBatch(row));
}

batchesRouter.get('/:id', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  getBatchHandler(req, res);
});

// ---- DELETE /v1/batches/:id ----

export function cancelBatchHandler(req: Request, res: Response) {
  const db = getDb();
  const row = db.prepare('SELECT id, status FROM batches WHERE id = ?').get(req.params.id) as { id: string; status: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'batch not found', type: 'invalid_request' } });
    return;
  }
  if (!['queued', 'processing'].includes(row.status)) {
    res.status(409).json({ error: { message: `batch already ${row.status}`, type: 'invalid_request', code: 'already_terminal' } });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE batches SET status='cancelled', finished_at=datetime('now') WHERE id=?`).run(req.params.id);
    const result = db.prepare(`UPDATE batch_items SET status='cancelled' WHERE batch_id=? AND status='pending'`).run(req.params.id);
    return result.changes;
  });
  const cancelled = tx();

  res.json({ id: req.params.id, status: 'cancelled', cancelled_pending: cancelled });
}

batchesRouter.delete('/:id', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  cancelBatchHandler(req, res);
});

// ---- GET /v1/batches/:id/results (JSONL) ----

export function resultsBatchHandler(req: Request, res: Response) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM batches WHERE id = ?').get(req.params.id);
  if (!exists) {
    res.status(404).json({ error: { message: 'batch not found', type: 'invalid_request' } });
    return;
  }

  const since = req.query.since ? Number(req.query.since) : -1;
  const rows = db.prepare(`
    SELECT position, custom_id, status, response_body, error_message, routed_platform, routed_model, latency_ms, attempt
    FROM batch_items
    WHERE batch_id = ? AND position > ? AND status IN ('done','error','cancelled')
    ORDER BY position ASC
  `).all(req.params.id, since) as any[];

  res.setHeader('Content-Type', 'application/x-ndjson');
  for (const r of rows) {
    const line: any = {
      custom_id: r.custom_id,
      position: r.position,
      status: r.status,
      latency_ms: r.latency_ms,
      attempt: r.attempt,
    };
    if (r.status === 'done' && r.response_body) {
      const resp = JSON.parse(r.response_body);
      resp._routed_via = { platform: r.routed_platform, model: r.routed_model };
      line.response = resp;
    } else if (r.status === 'error') {
      line.error = { message: r.error_message ?? 'unknown error', type: 'provider_error' };
    } else if (r.status === 'cancelled') {
      line.error = { message: 'cancelled before processing', type: 'cancelled' };
    }
    res.write(JSON.stringify(line) + '\n');
  }
  res.end();
}

batchesRouter.get('/:id/results', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  resultsBatchHandler(req, res);
});
