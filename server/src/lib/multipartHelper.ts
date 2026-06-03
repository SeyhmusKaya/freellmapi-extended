import multer from 'multer';
import type { Request, RequestHandler } from 'express';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 4;

// Memory storage so we can sniff mime + base64-encode in the handler.
// CF, Pollinations, Zhipu accept reasonably small payloads, so RAM cost is
// acceptable for the typical single-image/audio call pattern.
const storage = multer.memoryStorage();

export const multipartImagesUpload: RequestHandler = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'mask',  maxCount: 1 },
]);

export const multipartAudioUpload: RequestHandler = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
}).single('file');

/**
 * Detect whether the incoming request looks like multipart/form-data.
 * Used to switch between the multer path and the JSON path within the
 * same endpoint handler — preserves backward compatibility with callers
 * that have been sending JSON since Faz 1.
 */
export function isMultipart(req: Request): boolean {
  const ct = req.headers['content-type'] ?? '';
  return ct.toString().toLowerCase().startsWith('multipart/');
}

/**
 * Convert a multer File buffer + mime into a data: URL the existing
 * runImageEdit / runAudioTranscription pipelines already accept. This means
 * the multipart wrapper costs only one buffer copy; no provider code
 * changes.
 */
export function fileToDataUrl(file: Express.Multer.File): string {
  const mime = file.mimetype || 'application/octet-stream';
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

/**
 * Build a JSON-shaped body from a multer-parsed request. Maps known image
 * fields (`image`, `mask`) and text fields (`prompt`, `model`, `n`, `size`,
 * `response_format`, `seed`, `strength`, `negative_prompt`, `quality`) into
 * what imageEditSchema / imageGenerationSchema expect.
 *
 * Numeric strings (`n`, `seed`, `strength`) are coerced to numbers — Zod's
 * coerce option would do this too but we keep parsing local for clarity.
 */
export function multipartImageBody(req: Request): Record<string, unknown> {
  const files = (req.files as { [k: string]: Express.Multer.File[] } | undefined) ?? {};
  const out: Record<string, unknown> = {};

  if (files.image?.[0]) out.image = fileToDataUrl(files.image[0]);
  if (files.mask?.[0])  out.mask  = fileToDataUrl(files.mask[0]);

  const text = req.body as Record<string, string | undefined>;
  if (text.prompt)            out.prompt          = text.prompt;
  if (text.model)             out.model           = text.model;
  if (text.size)              out.size            = text.size;
  if (text.response_format)   out.response_format = text.response_format;
  if (text.negative_prompt)   out.negative_prompt = text.negative_prompt;
  if (text.quality)           out.quality         = text.quality;
  if (text.n        != null)  out.n        = Number(text.n);
  if (text.seed     != null)  out.seed     = Number(text.seed);
  if (text.strength != null)  out.strength = Number(text.strength);

  return out;
}

export function multipartAudioBody(req: Request): Record<string, unknown> {
  const file = req.file as Express.Multer.File | undefined;
  const text = req.body as Record<string, string | undefined>;
  const out: Record<string, unknown> = {};
  if (file) out.audio = fileToDataUrl(file);
  if (text.model)             out.model           = text.model;
  if (text.language)          out.language        = text.language;
  if (text.response_format)   out.response_format = text.response_format;
  if (text.prompt)            out.prompt          = text.prompt;
  if (text.temperature != null) out.temperature = Number(text.temperature);
  return out;
}
