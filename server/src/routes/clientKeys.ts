import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  listClientKeys,
  createClientKey,
  updateClientKey,
  deleteClientKey,
  getClientKey,
  revealClientKey,
} from '../db/index.js';

export const clientKeysRouter = Router();

// All endpoints in this router are dashboard-only (mounted under /api/*), so
// they ride on the same admin gate as the rest of /api/*. No public access.

const createBody = z.object({
  name: z.string().min(1).max(80).trim(),
});

const patchBody = z.object({
  name: z.string().min(1).max(80).trim().optional(),
  enabled: z.boolean().optional(),
});

// GET /api/client-keys — list all client keys. Plain key value is NEVER
// returned (only the prefix for UI display); the only chance to see it is
// the response to POST below.
clientKeysRouter.get('/', (_req: Request, res: Response) => {
  res.json(listClientKeys());
});

// POST /api/client-keys — create a new named key. Returns the plain key
// ONCE; the caller must copy it before closing the modal.
clientKeysRouter.post('/', (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { row, plainKey } = createClientKey(parsed.data.name);
  res.status(201).json({ ...row, key: plainKey });
});

// GET /api/client-keys/:id/reveal — decrypt and return the plain key value.
// Dashboard-only (sits behind the /api/* nginx gate). Returns 410 when the
// row predates V49 and has no ciphertext stored — operator must regenerate.
clientKeysRouter.get('/:id/reveal', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { message: 'invalid id' } });
    return;
  }
  const row = getClientKey(id);
  if (!row) {
    res.status(404).json({ error: { message: 'client key not found' } });
    return;
  }
  const plain = revealClientKey(id);
  if (!plain) {
    res.status(410).json({ error: { message: 'plain value no longer stored — regenerate the key to obtain a new one' } });
    return;
  }
  res.json({ id, name: row.name, key: plain });
});

// PATCH /api/client-keys/:id — rename or enable/disable.
clientKeysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { message: 'invalid id' } });
    return;
  }
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const existing = getClientKey(id);
  if (!existing) {
    res.status(404).json({ error: { message: 'client key not found' } });
    return;
  }
  // Protect the seeded "Genel" key from being disabled — every existing
  // project points at it and a UI slip would brick all of them at once.
  if (id === 1 && parsed.data.enabled === false) {
    res.status(400).json({ error: { message: 'The default key cannot be disabled' } });
    return;
  }
  const updated = updateClientKey(id, parsed.data);
  res.json(updated);
});

// DELETE /api/client-keys/:id — hard delete. id=1 ("Genel") is protected.
clientKeysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: { message: 'invalid id' } });
    return;
  }
  if (id === 1) {
    res.status(400).json({ error: { message: 'The default key cannot be deleted' } });
    return;
  }
  const ok = deleteClientKey(id);
  if (!ok) {
    res.status(404).json({ error: { message: 'client key not found' } });
    return;
  }
  res.status(204).end();
});
