import { z } from 'zod';
import sharp from 'sharp';
import { runImageEdit } from './runImageEdit.js';
import { RoutingError } from './runChatCompletion.js';

const directionEnum = z.enum(['all', 'left', 'right', 'top', 'bottom']);

export const imageOutpaintSchema = z.object({
  prompt: z.string().min(1).max(4000),
  image: z.string().refine(
    u => u.startsWith('data:image/') || u.startsWith('https://') || u.startsWith('http://'),
    { message: 'image must be data:image/* or http(s)://' },
  ),
  model: z.string().optional(),
  direction: directionEnum.optional(),
  pixels: z.number().int().min(32).max(512).optional(),
  size: z.enum(['512x512', '1024x1024', '1024x768', '768x1024']).optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
  seed: z.number().int().optional(),
  strength: z.number().min(0).max(1).optional(),
});

export type ImageOutpaintRequest = z.infer<typeof imageOutpaintSchema>;

/**
 * Loads the source image bytes (data URL or http) into a sharp buffer.
 * sharp accepts Buffer input directly so we keep things in-memory.
 */
async function loadImageBuffer(ref: string): Promise<Buffer> {
  if (ref.startsWith('data:')) {
    const m = ref.match(/^data:image\/[\w+.-]+;base64,(.+)$/);
    if (!m) throw new Error('invalid data URL');
    return Buffer.from(m[1], 'base64');
  }
  const url = new URL(ref);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^(10|127|169\.254|192\.168)\./.test(host)) {
    throw new Error('image url host blocked (private/loopback)');
  }
  const res = await fetch(ref, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Build the outpaint canvas + mask. The source image is composited onto
 * a larger canvas; the new edge pixels become the inpainting target.
 *
 * Mask convention for CF SD-1.5-inpainting: WHITE pixels are repainted,
 * BLACK pixels stay. So:
 *   - new edge ring (around source) = white
 *   - source area = black
 */
async function buildOutpaintCanvas(srcBuf: Buffer, direction: string, pixels: number) {
  const meta = await sharp(srcBuf).metadata();
  const srcW = meta.width ?? 512;
  const srcH = meta.height ?? 512;

  // Compute extension per side based on direction
  const extLeft   = (direction === 'left'  || direction === 'all') ? pixels : 0;
  const extRight  = (direction === 'right' || direction === 'all') ? pixels : 0;
  const extTop    = (direction === 'top'   || direction === 'all') ? pixels : 0;
  const extBottom = (direction === 'bottom'|| direction === 'all') ? pixels : 0;

  const newW = srcW + extLeft + extRight;
  const newH = srcH + extTop + extBottom;

  // Canvas: white background (will be repainted). Source pasted at offset.
  const canvas = await sharp({
    create: { width: newW, height: newH, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .composite([{ input: srcBuf, left: extLeft, top: extTop }])
    .png()
    .toBuffer();

  // Mask: black where source sits (keep), white outside (repaint).
  // Sharp 'create' with black bg + composite a white source-sized rect is
  // backwards — easier to start white and overlay a black rect for source.
  const maskCanvas = await sharp({
    create: { width: newW, height: newH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{
      input: await sharp({
        create: { width: srcW, height: srcH, channels: 3, background: { r: 0, g: 0, b: 0 } },
      }).png().toBuffer(),
      left: extLeft,
      top: extTop,
    }])
    .png()
    .toBuffer();

  return { canvas, mask: maskCanvas, width: newW, height: newH };
}

export async function runImageOutpaint(parsed: ImageOutpaintRequest) {
  const direction = parsed.direction ?? 'all';
  const pixels = parsed.pixels ?? 256;

  let srcBuf: Buffer;
  try {
    srcBuf = await loadImageBuffer(parsed.image);
  } catch (e: any) {
    throw new RoutingError(`Could not load source image: ${e?.message ?? 'unknown error'}`, 400);
  }

  let canvas: Buffer, mask: Buffer, width: number, height: number;
  try {
    const out = await buildOutpaintCanvas(srcBuf, direction, pixels);
    canvas = out.canvas; mask = out.mask; width = out.width; height = out.height;
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg.includes('unsupported image format') || msg.includes('Input file is missing') || msg.includes('Input buffer')) {
      throw new RoutingError(
        `Unsupported image format. Supported: PNG, JPEG, WebP, GIF, TIFF, AVIF, HEIF. Got: ${msg}`,
        400,
      );
    }
    throw new RoutingError(`Failed to build outpaint canvas: ${msg}`, 400);
  }

  // Re-use the existing edits pipeline. We force the inpainting model
  // because outpainting requires mask-driven generation.
  const result = await runImageEdit({
    prompt: parsed.prompt,
    image: `data:image/png;base64,${canvas.toString('base64')}`,
    mask:  `data:image/png;base64,${mask.toString('base64')}`,
    model: parsed.model ?? '@cf/runwayml/stable-diffusion-v1-5-inpainting',
    n: 1,
    size: `${width >= 1024 ? '1024x1024' : '512x512'}` as any,
    response_format: parsed.response_format ?? 'b64_json',
    seed: parsed.seed,
    strength: parsed.strength,
  });

  return result;
}
