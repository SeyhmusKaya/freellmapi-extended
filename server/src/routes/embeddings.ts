import { Router, type Request, type Response } from 'express';
import { embeddingSchema, runEmbedding } from '../lib/runEmbedding.js';
import {
  AllProvidersFailedError,
  ModelNotFoundError,
  ProviderFatalError,
  RoutingError,
} from '../lib/runChatCompletion.js';
import { authenticateClient } from '../lib/clientAuth.js';

export const embeddingsRouter = Router();

function authenticate(req: Request, res: Response): boolean {
  return authenticateClient(req, res);
}

/**
 * POST /v1/embeddings  (OpenAI-compatible)
 *
 *   body: {
 *     model?: string,            // catalog model_id; omit for auto-route
 *     input: string | string[],  // single or batch (max 2048 inputs)
 *     dimensions?: number,       // Matryoshka cap (Gemini/Cohere v4 only)
 *     encoding_format?: 'float' | 'base64',
 *     input_type?: 'search_document' | 'search_query' | 'classification' | 'clustering',
 *     user?: string,
 *   }
 *
 * Reply (matches OpenAI shape):
 *   {
 *     object: 'list',
 *     data: [{object:'embedding', embedding: number[], index: number}, ...],
 *     model: '<routed model_id>',
 *     usage: { prompt_tokens, total_tokens },
 *     _routed_via: { platform, model }     // myllm extension
 *   }
 *
 * Routing: cascade across the embedding catalog (V30) - CF BGE-M3 first,
 * then Google embedding-001, Cohere v3 multilingual, Mistral, Zhipu, GitHub.
 * On rate-limit / 5xx / timeout the next provider is tried automatically.
 */
embeddingsRouter.post('/embeddings', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const parsed = embeddingSchema.safeParse(req.body);
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
    const result = await runEmbedding(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));

    res.json({
      object: 'list',
      data: result.vectors.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding,
      })),
      model: result.routedModel,
      usage: {
        prompt_tokens: result.promptTokens,
        total_tokens: result.promptTokens,
      },
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
    console.error('[Embeddings] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});
