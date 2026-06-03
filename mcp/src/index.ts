#!/usr/bin/env node
/**
 * MyLLM Image MCP server.
 *
 * Exposes a `generate_image` tool that proxies to a MyLLM deployment's
 * OpenAI-compatible `/v1/images/generations` endpoint. Designed for Claude
 * Code (stdio transport): the model can generate images mid-session.
 *
 * Configuration (environment, set in the MCP client config — never in code):
 *   MYLLM_API_URL   base URL, e.g. https://myapi.example.com   (required)
 *   MYLLM_API_KEY   unified Bearer key                          (required)
 *   MYLLM_IMAGE_DIR default directory for saved PNGs (optional; else cwd)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const API_URL = (process.env.MYLLM_API_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.MYLLM_API_KEY ?? '';
const DEFAULT_DIR = process.env.MYLLM_IMAGE_DIR ?? process.cwd();

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

const server = new McpServer({ name: 'myllm-image', version: '0.1.0' });

server.registerTool(
  'generate_image',
  {
    title: 'Generate image',
    description:
      'Generate one or more images from a text prompt via the MyLLM image '
      + 'router. Returns the image(s) inline and also saves PNG file(s) to '
      + 'disk, reporting the saved path(s).',
    inputSchema: {
      prompt: z.string().min(1).describe('Text description of the image to generate.'),
      model: z.string().optional().describe(
        'Optional specific image model id. Omit to let MyLLM auto-route to '
        + 'the best available model.'),
      size: z.string().optional().describe('Image size, e.g. "1024x1024". Default 1024x1024.'),
      n: z.number().int().min(1).max(4).optional().describe('How many images (1-4). Default 1.'),
      save_dir: z.string().optional().describe(
        'Directory to write the PNG file(s) into. Defaults to the current '
        + 'working directory (or MYLLM_IMAGE_DIR).'),
    },
  },
  async ({ prompt, model, size, n, save_dir }) => {
    if (!API_URL || !API_KEY) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'MyLLM MCP not configured: set MYLLM_API_URL and MYLLM_API_KEY '
            + 'in the MCP server env.',
        }],
      };
    }

    const body: Record<string, unknown> = {
      prompt,
      n: n ?? 1,
      size: size ?? '1024x1024',
      response_format: 'b64_json',
    };
    if (model) body.model = model;

    let res: Response;
    try {
      res = await fetch(`${API_URL}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Request failed: ${e?.message ?? e}` }],
      };
    }

    const routedVia = res.headers.get('X-Routed-Via') ?? 'unknown';
    const json = (await res.json().catch(() => ({}))) as ImagesResponse;

    if (!res.ok) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `MyLLM image generation failed (HTTP ${res.status}): `
            + (json.error?.message ?? 'unknown error'),
        }],
      };
    }

    const images = (json.data ?? []).filter(d => d.b64_json);
    if (images.length === 0) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'MyLLM returned no image data. (URL-format responses are not '
            + 'supported by this tool — it requests b64_json.)',
        }],
      };
    }

    const dir = resolve(save_dir ?? DEFAULT_DIR);
    try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }

    const ts = timestamp();
    const savedPaths: string[] = [];
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > = [];

    images.forEach((img, i) => {
      const b64 = img.b64_json!;
      const fileName = `myllm-image-${ts}${images.length > 1 ? `-${i + 1}` : ''}.png`;
      const filePath = join(dir, fileName);
      try {
        writeFileSync(filePath, Buffer.from(b64, 'base64'));
        savedPaths.push(filePath);
      } catch (e: any) {
        content.push({ type: 'text', text: `Could not save image ${i + 1}: ${e?.message ?? e}` });
      }
      content.push({ type: 'image', data: b64, mimeType: 'image/png' });
    });

    content.unshift({
      type: 'text',
      text: `Generated ${images.length} image(s) via ${routedVia}.`
        + (savedPaths.length ? `\nSaved to:\n${savedPaths.map(p => `  ${p}`).join('\n')}` : ''),
    });

    return { content };
  },
);

server.registerTool(
  'list_image_models',
  {
    title: 'List image models',
    description:
      'List the image-generation model ids available on the MyLLM '
      + 'deployment. Pass one of these as the `model` argument to '
      + 'generate_image to pin a specific model; omit it to auto-route.',
    inputSchema: {},
  },
  async () => {
    if (!API_URL || !API_KEY) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'MyLLM MCP not configured: set MYLLM_API_URL and MYLLM_API_KEY.',
        }],
      };
    }
    let res: Response;
    try {
      res = await fetch(`${API_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Request failed: ${e?.message ?? e}` }],
      };
    }
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `MyLLM /v1/models failed: HTTP ${res.status}` }],
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id: string; owned_by?: string; name?: string; modality?: string }>;
    };
    const imageModels = (json.data ?? []).filter(m => m.modality === 'image_gen');
    if (imageModels.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No image-generation models found.' }] };
    }
    const lines = imageModels.map(m => `  ${m.id}  (${m.owned_by ?? '?'}) — ${m.name ?? ''}`);
    return {
      content: [{
        type: 'text' as const,
        text: `Image-generation models (${imageModels.length}):\n${lines.join('\n')}\n\n`
          + 'Pass an id as generate_image\'s `model` argument, or omit it to '
          + 'auto-route to the best available model.',
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
