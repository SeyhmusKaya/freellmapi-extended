import type { Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { authenticateApiKey } from '../db/index.js';

/**
 * AsyncLocalStorage that carries the authenticated client_key_id (and
 * optionally the resolved end-user id) across the async chain of a request.
 * The store object is MUTABLE — setEndUserId() writes into it after auth.
 */
export const clientCtx = new AsyncLocalStorage<{ clientKeyId: number; endUserId?: string | null }>();

/**
 * Bearer-token auth gate shared by every public /v1/* endpoint.
 *
 * Looks the token up in `client_keys` (V44) — the seeded "Genel" key plus any
 * per-project keys the operator created. Resolved id+name is attached to the
 * request so route handlers can pass it to `logRequest` for per-key analytics.
 *
 * Returns `false` and writes a 401 if the token is missing / unknown /
 * disabled; returns `true` after attaching identity otherwise.
 */
export function authenticateClient(req: Request, res: Response): boolean {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const auth = authenticateApiKey(token);
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return false;
  }
  (req as any).clientKeyId = auth.id;
  (req as any).clientKeyName = auth.name;
  // enterWith stays effective for the rest of this request's async chain, so
  // logRequest() reads the id even from deep inside the provider plumbing.
  // The store object is a mutable reference — setEndUserId() updates it later.
  clientCtx.enterWith({ clientKeyId: auth.id, endUserId: null });
  return true;
}

export function getClientKeyId(req: Request): number | undefined {
  return (req as any).clientKeyId;
}

/**
 * Sanitise a raw end-user id string: trim, collapse empty to null, cap at 200
 * characters. Returns the clean value.
 */
function sanitise(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 200);
}

/**
 * Write the end-user id onto the request object AND into the AsyncLocalStorage
 * store so downstream logRequest() picks it up without parameter threading.
 */
export function setEndUserId(req: Request, id: string | null | undefined): void {
  const clean = sanitise(id);
  (req as any).endUserId = clean;
  const s = clientCtx.getStore();
  if (s) s.endUserId = clean;
}

/**
 * Resolve the end-user identity from (in priority order):
 *   1. body `user` field
 *   2. X-End-User-Id request header
 * Sanitises, calls setEndUserId, and returns the clean value (or null).
 */
export function resolveEndUserId(req: Request, bodyUser?: string | null): string | null {
  const raw =
    bodyUser ??
    (req.headers['x-end-user-id'] as string | undefined) ??
    null;
  const clean = sanitise(raw);
  setEndUserId(req, clean);
  return clean;
}
