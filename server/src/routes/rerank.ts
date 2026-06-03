import { Router, type Request, type Response } from 'express';
import { rerankSchema, runRerank } from '../lib/runRerank.js';
import {
  AllProvidersFailedError,
  ModelNotFoundError,
  ProviderFatalError,
  RoutingError,
} from '../lib/runChatCompletion.js';
import { authenticateClient } from '../lib/clientAuth.js';

export const rerankRouter = Router();

function authenticate(req: Request, res: Response): boolean {
  return authenticateClient(req, res);
}

/**
 * POST /v1/rerank — document re-ranking (Cohere-style).
 *
 *   body: {
 *     model?: string,                          // catalog model_id; omit for auto-route
 *     query: string,                           // user's search query
 *     documents: string[],                     // candidate docs to rank
 *     top_n?: number,                          // return only top N (default all)
 *     max_chunks_per_doc?: number,             // long-doc chunk cap
 *     return_documents?: boolean,              // echo source text in results
 *   }
 *
 * Reply:
 *   {
 *     results: [
 *       {index: int, relevance_score: 0..1, document?: string},  // sorted DESC by score
 *       ...
 *     ],
 *     model: '<routed model_id>',
 *     usage: { search_units },
 *     _routed_via: { platform, model }
 *   }
 *
 * Use case: RAG pipelines. After embedding-based retrieval pulls top-100
 * candidates, rerank fine-tunes to the top-10 actually relevant docs.
 */
rerankRouter.post('/rerank', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const parsed = rerankSchema.safeParse(req.body);
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
    const result = await runRerank(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));

    res.json({
      results: result.results,
      model: result.routedModel,
      usage: { search_units: result.searchUnits },
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
    console.error('[Rerank] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});
