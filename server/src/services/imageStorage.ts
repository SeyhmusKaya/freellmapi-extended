import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { ulid } from '../lib/ulid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.resolve(__dirname, '../../data/images');
const DEFAULT_EXPIRY_HOURS = Number(process.env.MYLLM_IMAGE_URL_EXPIRY_HOURS ?? 24);
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_SWEEP_MS = 60 * 1000;

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface StoredImage {
  id: string;
  url: string;          // signed retrieval URL (full https://...)
  expiresAt: string;    // ISO8601 UTC
}

/**
 * Persist an image's bytes to local FS and return a signed URL clients can
 * fetch via GET /v1/images/files/<id>?sig=...&exp=....
 *
 * Signing: HMAC-SHA256 over `<id>:<exp_unix>`, key = unified API key. Bound to
 * an expiry timestamp so a stolen URL stops working at exp time, and tied to
 * the per-deployment unified key so URLs can't be forged by an outsider.
 */
export function storeImage(b64: string, mimeType: string, opts: {
  platform?: string;
  modelId?: string;
  publicBase?: string;
  expiresInHours?: number;
}): StoredImage {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const id = ulid();
  const ext = MIME_TO_EXT[mimeType] ?? 'bin';
  const filePath = path.join(STORAGE_DIR, `${id}.${ext}`);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(filePath, buf);

  const hours = opts.expiresInHours ?? DEFAULT_EXPIRY_HOURS;
  const expiresAtMs = Date.now() + hours * 3600 * 1000;
  const expUnix = Math.floor(expiresAtMs / 1000);
  const expiresAt = new Date(expiresAtMs).toISOString().replace('T', ' ').slice(0, 19);

  getDb().prepare(`
    INSERT INTO image_files (id, file_path, mime_type, byte_size, platform, model_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, filePath, mimeType, buf.length, opts.platform ?? null, opts.modelId ?? null, expiresAt);

  const sig = signId(id, expUnix);
  const base = (opts.publicBase ?? process.env.MYLLM_PUBLIC_URL ?? 'https://myapi.example.com').replace(/\/$/, '');
  const url = `${base}/v1/images/files/${id}.${ext}?exp=${expUnix}&sig=${sig}`;

  return { id, url, expiresAt };
}

export function signId(id: string, expUnix: number): string {
  const key = getUnifiedApiKey();
  return crypto.createHmac('sha256', key).update(`${id}:${expUnix}`).digest('hex');
}

export function verifySignedRequest(idWithExt: string, expStr: string | undefined, sig: string | undefined): { ok: true; id: string } | { ok: false; status: number; reason: string } {
  if (!expStr || !sig) return { ok: false, status: 401, reason: 'missing signature' };
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, status: 401, reason: 'bad exp' };
  if (Date.now() / 1000 > exp) return { ok: false, status: 410, reason: 'expired' };

  // Strip extension from id portion
  const id = idWithExt.replace(/\.(png|jpg|jpeg|webp|gif|bin)$/i, '');
  // Defensive: id is ULID, 26 chars Crockford base32
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) {
    return { ok: false, status: 400, reason: 'bad id' };
  }

  const expectedSig = signId(id, exp);
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: 'bad signature' };
  }
  return { ok: true, id };
}

export interface ImageFileRow {
  id: string;
  file_path: string;
  mime_type: string;
  byte_size: number;
  expires_at: string;
}

export function getImageFile(id: string): ImageFileRow | null {
  return (getDb().prepare(`SELECT id, file_path, mime_type, byte_size, expires_at FROM image_files WHERE id = ?`).get(id) as ImageFileRow | undefined) ?? null;
}

/**
 * Retention sweeper. Deletes both the FS file and the DB row for any image
 * whose expires_at has passed. Runs every 6h after a 1m warm-up.
 */
export function startImageRetention() {
  function sweep() {
    try {
      const db = getDb();
      const expired = db.prepare(`SELECT id, file_path FROM image_files WHERE expires_at < datetime('now')`).all() as Array<{ id: string; file_path: string }>;
      if (expired.length === 0) return;
      for (const row of expired) {
        try { fs.unlinkSync(row.file_path); } catch { /* file gone already */ }
      }
      const del = db.prepare(`DELETE FROM image_files WHERE expires_at < datetime('now')`).run();
      console.log(`[ImageRetention] purged ${del.changes} expired images`);
    } catch (e) {
      console.error('[ImageRetention] sweep failed:', e);
    }
  }
  setTimeout(sweep, FIRST_SWEEP_MS);
  setInterval(sweep, SWEEP_INTERVAL_MS);
  console.log(`[ImageRetention] scheduler started (expiry=${DEFAULT_EXPIRY_HOURS}h, sweep=${SWEEP_INTERVAL_MS / 3600_000}h)`);
}
