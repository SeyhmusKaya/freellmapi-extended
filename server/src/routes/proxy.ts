import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ChatMessage } from '@myllm/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, classifyError } from '../services/ratelimit.js';
import { getDb } from '../db/index.js';
import { authenticateClient, resolveEndUserId } from '../lib/clientAuth.js';
import { checkEndUserLimit } from '../lib/endUserLimits.js';
import {
  chatCompletionSchema,
  isRetryableError,
  isModelLevelFailure,
  isBadRequestError,
  normalizeMessages,
  resolvePreferredModel,
  resolveAlias,
  setStickyModel,
  logRequest,
  runChatCompletion,
  ModelNotFoundError,
  AllProvidersFailedError,
  ProviderFatalError,
  RoutingError,
} from '../lib/runChatCompletion.js';

export const proxyRouter = Router();

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(
    "SELECT platform, model_id, display_name, context_window, COALESCE(modality,'text') AS modality "
    + 'FROM models WHERE enabled = 1 ORDER BY intelligence_rank'
  ).all() as any[];
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.model_id,
      object: 'model',
      created: 0,
      owned_by: m.platform,
      name: m.display_name,
      context_window: m.context_window,
      // Non-standard but harmless extension: lets clients (e.g. the image
      // MCP) filter by modality without a separate admin endpoint.
      modality: m.modality,
    })),
  });
});

// Streaming cascade ceiling. 20 was too high — under a burst that cools the
// top of the fallback chain, every retry tacks another TTFB window onto the
// total wait. 8 (≈ 8 * 45s worst case = 6 min) is already past any reasonable
// interactive budget; if the first 8 healthy keys can't serve the request,
// the next ones won't either and 429 is a faster signal to the caller.
const MAX_RETRIES = 8;

// Streaming time-to-first-byte budget. fetchWithTimeout only bounds the
// header phase for streams (the timer is cleared once headers arrive, so the
// body itself is unbounded). 25s: a healthy NVIDIA / Cerebras / CF call lands
// the first token in <5s on tiny prompts and <20s on a 50K-token coding
// context. Anything beyond 25s is almost always an upstream hang — fail fast
// and cascade rather than tack 45s of dead-air onto every retry under burst.
const STREAM_TTFB_TIMEOUT_MS = 25000;

function authenticate(req: Request, res: Response): boolean {
  // SECURITY: localhost bypass removed — app sits behind nginx (127.0.0.1 origin)
  // so a bypass exposes /v1 publicly. Bearer token now always required.
  return authenticateClient(req, res);
}

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  if (parsed.data.stream) {
    return handleStreamingCompletion(req, res, parsed.data);
  }

  // Resolve + store end-user identity (sets ctx store for logRequest downstream)
  const endUser = resolveEndUserId(req, parsed.data.user);
  // Check per-user spend limit before touching any upstream provider
  const chk = checkEndUserLimit((req as any).clientKeyId, endUser);
  if (!chk.allowed) {
    res.status(429).json({
      error: {
        message: `End-user spend limit exceeded (${chk.exceeded})`,
        type: 'end_user_limit_exceeded',
      },
    });
    return;
  }

  try {
    const result = await runChatCompletion(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));
    res.json(result.response);
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: err.code } });
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
    console.error('[Proxy] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});

async function handleStreamingCompletion(
  req: Request,
  res: Response,
  data: ReturnType<typeof chatCompletionSchema.parse>,
) {
  // Resolve end-user identity and check spend limit before hitting any upstream
  const endUser = resolveEndUserId(req, data.user);
  const chk = checkEndUserLimit((req as any).clientKeyId, endUser);
  if (!chk.allowed) {
    res.status(429).json({
      error: {
        message: `End-user spend limit exceeded (${chk.exceeded})`,
        type: 'end_user_limit_exceeded',
      },
    });
    return;
  }

  const start = Date.now();
  // Per-incoming-request id so analytics can group the cascade attempts of one
  // streaming call together (real failure vs recovered-retry separation).
  const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, response_format } = data;
  const messages: ChatMessage[] = normalizeMessages(data.messages);

  const estimatedInputTokens = messages.reduce((sum, m) => {
    if (typeof m.content !== 'string') return sum;
    return sum + Math.ceil(m.content.length / 4);
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  const requireVision = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
  const requireJsonMode = response_format != null
    && (response_format.type === 'json_object' || response_format.type === 'json_schema');

  // Fixed alias chains (`coding`, `askpusulasi`, ...) — must be handled here
  // too: streaming clients (Cline, the Aşk Pusulası chat UI, etc.) hit this path.
  const alias = resolveAlias(data.model);
  const aliasChain = alias?.chain;
  const aliasPlatforms = alias?.restrictToPlatforms;

  let preferredModel: number | undefined;
  try {
    preferredModel = alias
      ? undefined
      : resolvePreferredModel(data.model, messages, requireVision, requireJsonMode);
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: err.code } });
      return;
    }
    throw err;
  }

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;
  // Headers are committed once the first real chunk OR a keepalive heartbeat
  // is written. Tracked across attempts: a cascade can switch models after
  // the heartbeat already flushed headers — that is fine, only keepalive
  // comments went out so far and the client still sees one continuous stream.
  let headersFlushed = false;

  // Terminal error emitter. Before headers are committed it sends a normal
  // HTTP error; once committed it must stay inside the SSE stream.
  const endWithError = (httpStatus: number, message: string, type: string) => {
    if (headersFlushed || res.headersSent) {
      try { res.write(`data: ${JSON.stringify({ error: { message, type } })}\n\n`); } catch { /* socket gone */ }
      try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
    } else {
      res.status(httpStatus).json({ error: { message, type } });
    }
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, requireVision, requireJsonMode, false, 'text', undefined, aliasChain, aliasPlatforms, skipModels.size > 0 ? skipModels : undefined);
    } catch (err: any) {
      if (lastError) {
        endWithError(429, `All models rate-limited. Last error: ${lastError.message}`, 'rate_limit_error');
      } else {
        endWithError(err.status ?? 503, err.message, 'routing_error');
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    let totalOutputTokens = 0;
    let streamStarted = false;   // first REAL chunk delivered
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const flushHeaders = () => {
      if (headersFlushed) return;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      headersFlushed = true;
    };

    try {
      const gen = route.provider.streamChatCompletion(
        route.apiKey, messages, route.modelId,
        { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, response_format,
          timeoutMs: STREAM_TTFB_TIMEOUT_MS },
      );

      // Heartbeat: a model can take a while to prefill a large coding prompt
      // before the first token. Cloudflare 524s an origin that sends nothing
      // for ~100s, so emit an SSE comment every 15s while we wait. A model
      // switch after the heartbeat is still transparent — only keepalive
      // comments went out, so a pre-first-chunk error can still cascade.
      heartbeat = setInterval(() => {
        flushHeaders();
        try { res.write(': keepalive\n\n'); } catch { /* socket gone */ }
      }, 15000);

      for await (const chunk of gen) {
        if (!streamStarted) {
          flushHeaders();
          streamStarted = true;
        }
        const text = chunk.choices[0]?.delta?.content ?? '';
        totalOutputTokens += Math.ceil(text.length / 4);
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      flushHeaders();
      res.write('data: [DONE]\n\n');
      res.end();

      recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
      recordSuccess(route.modelDbId);
      setStickyModel(messages, route.modelDbId);
      if (!data.probe) logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'success',
        inputTokens: estimatedInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs: Date.now() - start,
        error: null,
        attempts: attempt,
        keyId: route.keyId,
        requestId: reqId,
      });
      return;
    } catch (err: any) {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      const latency = Date.now() - start;
      if (!data.probe) logRequest({
        platform: route.platform,
        modelId: route.modelId,
        status: 'error',
        inputTokens: estimatedInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs: latency,
        error: err?.message ?? 'unknown',
        errorClass: classifyError(err?.message ?? ''),
        attempts: attempt,
        keyId: route.keyId,
        requestId: reqId,
      });

      // A real chunk already went out — the partial response is committed, so
      // a model switch is impossible. Surface the break as an SSE error.
      if (streamStarted) {
        console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, err.message);
        const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
        try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
        return;
      }

      // No real chunk yet (only keepalive comments may have gone out) — safe
      // to cascade to another model even if the heartbeat flushed headers.
      if (isRetryableError(err)) {
        const reason = classifyError(err.message);
        if (isModelLevelFailure(err) || reason === 'model_gone') {
          // Endpoint hung/unreachable, or the model id no longer resolves
          // (model_gone) — skip the WHOLE model for this request so the cascade
          // does not burn another full timeout / re-404 on its other keys.
          skipModels.add(route.modelDbId);
        } else {
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        }
        setCooldown(route.platform, route.modelId, route.keyId, reason);
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Provider-specific 400/422 before any chunk flushed — skip this model
      // and cascade rather than sinking the request on one quirky endpoint.
      if (isBadRequestError(err) && !streamStarted) {
        skipModels.add(route.modelDbId);
        setCooldown(route.platform, route.modelId, route.keyId, 'rate_limit_unknown');
        lastError = err;
        console.log(`[Proxy] 400/422 from ${route.displayName} (stream), skipping model (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      endWithError(502, `Provider error (${route.displayName}): ${err.message}`, 'provider_error');
      return;
    }
  }

  endWithError(429, `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`, 'rate_limit_error');
}
