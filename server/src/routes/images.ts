import fs from 'fs';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateClient } from '../lib/clientAuth.js';
import {
  imageGenerationSchema,
  runImageGeneration,
} from '../lib/runImageGeneration.js';
import {
  ModelNotFoundError,
  AllProvidersFailedError,
  ProviderFatalError,
  RoutingError,
} from '../lib/runChatCompletion.js';
import { storeImage, verifySignedRequest, getImageFile } from '../services/imageStorage.js';
import { imageEditSchema, imageVariationSchema, runImageEdit } from '../lib/runImageEdit.js';
import { imageOutpaintSchema, runImageOutpaint } from '../lib/runImageOutpaint.js';
import { multipartImagesUpload, isMultipart, multipartImageBody } from '../lib/multipartHelper.js';

export const imagesRouter = Router();

function authenticate(req: Request, res: Response): boolean {
  return authenticateClient(req, res);
}

// POST /v1/images/generations — OpenAI-compatible image generation.
//
// Body: { prompt, model?, n?, size?, response_format?, negative_prompt?,
//         seed?, quality? }. See docs/IMAGE-GEN-PLAN.md §1.
//
// Response: { created, data: [{ b64_json, revised_prompt }], _routed_via }.
//
// Faz 1: response_format='url' returns 400 (no storage backend yet).
imagesRouter.post('/generations', multipartImagesUpload, async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const body = isMultipart(req) ? multipartImageBody(req) : req.body;
  const parsed = imageGenerationSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => `${e.path.join('.')} ${e.message}`).join('; ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    const result = await runImageGeneration(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));

    const useUrl = parsed.data.response_format === 'url';
    const data = useUrl
      ? result.images.map(b64 => {
          const stored = storeImage(b64, result.mimeType, {
            platform: result.routedPlatform,
            modelId: result.routedModel,
          });
          return { url: stored.url, revised_prompt: null };
        })
      : result.images.map(b64 => ({ b64_json: b64, revised_prompt: null }));

    res.json({
      created: Math.floor(Date.now() / 1000),
      data,
      _routed_via: { platform: result.routedPlatform, model: result.routedModel },
    });
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
    if (err instanceof AllProvidersFailedError) {
      res.status(429).json({ error: { message: err.message, type: 'rate_limit_error' } });
      return;
    }
    if (err instanceof ProviderFatalError) {
      res.status(502).json({ error: { message: err.message, type: 'provider_error' } });
      return;
    }
    if (err instanceof RoutingError) {
      res.status(err.status).json({ error: { message: err.message, type: 'routing_error' } });
      return;
    }
    console.error('[ImageGen] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});

// Shared handler for /v1/images/edits and /v1/images/variations. Both call
// the same router gate (image_gen modality + supports_img2img|inpainting)
// and the same provider.editImage() — endpoint differs only in schema
// validation + which input fields are required.
//
// Faz 4: multipart/form-data is sniffed and re-shaped into the JSON body
// the existing schema expects. Pre-Faz 4 JSON callers keep working.
async function handleEdit(req: Request, res: Response, isVariation: boolean) {
  if (!authenticate(req, res)) return;

  const body = isMultipart(req) ? multipartImageBody(req) : req.body;
  const schema = isVariation ? imageVariationSchema : imageEditSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => `${e.path.join('.')} ${e.message}`).join('; ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    const result = await runImageEdit(parsed.data as any);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));

    const useUrl = parsed.data.response_format === 'url';
    const data = useUrl
      ? result.images.map(b64 => {
          const stored = storeImage(b64, result.mimeType, {
            platform: result.routedPlatform,
            modelId: result.routedModel,
          });
          return { url: stored.url, revised_prompt: null };
        })
      : result.images.map(b64 => ({ b64_json: b64, revised_prompt: null }));

    res.json({
      created: Math.floor(Date.now() / 1000),
      data,
      _routed_via: { platform: result.routedPlatform, model: result.routedModel },
    });
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
    if (err instanceof AllProvidersFailedError) {
      res.status(429).json({ error: { message: err.message, type: 'rate_limit_error' } });
      return;
    }
    if (err instanceof ProviderFatalError) {
      res.status(502).json({ error: { message: err.message, type: 'provider_error' } });
      return;
    }
    if (err instanceof RoutingError) {
      res.status(err.status).json({ error: { message: err.message, type: 'routing_error' } });
      return;
    }
    console.error('[ImageEdit] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
}

imagesRouter.post('/edits',      multipartImagesUpload, (req, res) => handleEdit(req, res, false));
imagesRouter.post('/variations', multipartImagesUpload, (req, res) => handleEdit(req, res, true));

// POST /v1/images/outpaint — extend the input image in the chosen direction.
// Internally builds an outpainting mask + uses the inpainting model so this
// endpoint relies on the same routing/cooldown plumbing as /edits.
imagesRouter.post('/outpaint', multipartImagesUpload, async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  const body = isMultipart(req) ? multipartImageBody(req) : req.body;
  const parsed = imageOutpaintSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => `${e.path.join('.')} ${e.message}`).join('; ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    const result = await runImageOutpaint(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));

    const useUrl = parsed.data.response_format === 'url';
    const data = useUrl
      ? result.images.map(b64 => {
          const stored = storeImage(b64, result.mimeType, {
            platform: result.routedPlatform,
            modelId: result.routedModel,
          });
          return { url: stored.url, revised_prompt: null };
        })
      : result.images.map(b64 => ({ b64_json: b64, revised_prompt: null }));

    res.json({
      created: Math.floor(Date.now() / 1000),
      data,
      _routed_via: { platform: result.routedPlatform, model: result.routedModel },
    });
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
    if (err instanceof AllProvidersFailedError) {
      res.status(429).json({ error: { message: err.message, type: 'rate_limit_error' } });
      return;
    }
    if (err instanceof ProviderFatalError) {
      res.status(502).json({ error: { message: err.message, type: 'provider_error' } });
      return;
    }
    if (err instanceof RoutingError) {
      res.status(err.status).json({ error: { message: err.message, type: 'routing_error' } });
      return;
    }
    console.error('[Outpaint] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});

// GET /v1/images/files/:id — signed-URL retrieval for response_format=url.
// No Bearer auth — protection is the HMAC signature + expiry tied to the
// unified API key. URL leaks expire on their own and can't be forged.
imagesRouter.get('/files/:id', (req: Request, res: Response) => {
  const idWithExt = String(req.params.id);
  const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
  const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;

  const verify = verifySignedRequest(idWithExt, exp, sig);
  if (!verify.ok) {
    res.status(verify.status).json({ error: { message: verify.reason, type: 'invalid_request_error' } });
    return;
  }

  const row = getImageFile(verify.id);
  if (!row) {
    res.status(404).json({ error: { message: 'image not found or expired', type: 'invalid_request_error' } });
    return;
  }
  // Re-check expiry from DB (defense-in-depth — signature exp could outlive
  // the row if retention swept it early).
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    res.status(410).json({ error: { message: 'image expired', type: 'invalid_request_error' } });
    return;
  }
  if (!fs.existsSync(row.file_path)) {
    res.status(410).json({ error: { message: 'image gone', type: 'invalid_request_error' } });
    return;
  }

  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Length', String(row.byte_size));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(row.file_path).pipe(res);
});
