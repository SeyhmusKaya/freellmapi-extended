import type { Request, Response, NextFunction } from 'express';

/**
 * Express error middleware.
 *
 * Logging policy:
 *   - 5xx (server fault) -> console.error (loud, visible in pm2 error log)
 *   - 4xx (client fault, e.g. bodyParser SyntaxError on malformed JSON) ->
 *     console.warn at most once per IP per minute. Without throttling these
 *     spam the log when a buggy client retries (saw 50+/min from one peer).
 *   - SyntaxError from body-parser specifically gets a stable 400 with a
 *     helpful pointer instead of the raw position offset.
 */
const recentClientWarn = new Map<string, number>();
const CLIENT_WARN_THROTTLE_MS = 60_000;

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const status = (err as any).status ?? (err as any).statusCode ?? 500;
  const isBodyParserSyntax = err instanceof SyntaxError && 'body' in (err as any);

  if (status >= 500) {
    console.error('[Error]', err.message);
  } else {
    // 4xx — throttle per client to avoid log spam from buggy clients
    const ip = (req.ip ?? req.socket?.remoteAddress ?? 'unknown') as string;
    const last = recentClientWarn.get(ip) ?? 0;
    const now = Date.now();
    if (now - last > CLIENT_WARN_THROTTLE_MS) {
      recentClientWarn.set(ip, now);
      console.warn(`[ClientError] ${status} from ${ip}: ${err.message}`);
    }
    // Periodic cleanup of stale entries
    if (recentClientWarn.size > 500) {
      for (const [k, t] of recentClientWarn) {
        if (now - t > CLIENT_WARN_THROTTLE_MS * 5) recentClientWarn.delete(k);
      }
    }
  }

  if (res.headersSent) return next(err);

  // Friendly message for malformed JSON bodies
  const message = isBodyParserSyntax
    ? `Malformed JSON body: ${err.message}. Check that Content-Type is application/json and the payload is valid JSON.`
    : err.message;

  res.status(status).json({
    error: {
      message,
      type: isBodyParserSyntax ? 'invalid_request_error' : (err.name ?? 'server_error'),
    },
  });
}
