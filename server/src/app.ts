import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { clientKeysRouter } from './routes/clientKeys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { batchesRouter } from './routes/batches.js';
import { adminBatchesRouter } from './routes/adminBatches.js';
import { imagesRouter } from './routes/images.js';
import { audioRouter } from './routes/audio.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { rerankRouter } from './routes/rerank.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { modelStatusRouter } from './routes/modelstatus.js';
import { errorHandler } from './middleware/errorHandler.js';
import { usageRouter } from './routes/usage.js';
import { pricingRouter } from './routes/pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors());
  // Batch endpoints accept up to 5MB JSON; vision payloads (base64-inlined
  // images) need ~25MB. Mount the higher limit on those paths before the
  // global 1MB parser so /api/* keeps its tighter cap.
  app.use('/v1/batches', express.json({ limit: '30mb' }));
  app.use('/v1/chat/completions', express.json({ limit: '25mb' }));
  app.use('/v1/images', express.json({ limit: '25mb' }));
  app.use('/v1/audio', express.json({ limit: '30mb' }));
  // /v1/embeddings: batches of up to ~2048 strings × 8K chars ≈ 16MB; cap at 20MB.
  app.use('/v1/embeddings', express.json({ limit: '20mb' }));
  // /v1/rerank: 1000 docs × 16K chars ≈ 16MB; cap at 20MB
  app.use('/v1/rerank', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '1mb' }));

  // API routes
  app.use('/api/keys', keysRouter);
  app.use('/api/client-keys', clientKeysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/model-status', modelStatusRouter);
  app.use('/api/batches', adminBatchesRouter);
  app.use('/api/pricing', pricingRouter);

  // OpenAI-compatible proxy. Mount batches + images before /v1 generic so
  // their routes resolve first (defense-in-depth even though proxyRouter
  // has no overlap).
  // Usage router must be mounted before the generic /v1 proxy (express picks
  // first match, and proxyRouter would otherwise swallow /v1/usage).
  app.use('/v1/usage', usageRouter);
  app.use('/v1/batches', batchesRouter);
  app.use('/v1/images', imagesRouter);
  app.use('/v1/audio', audioRouter);
  // /v1/embeddings — mounted as plain router (it defines POST /embeddings
  // internally, expecting consumer to hit /v1/embeddings)
  app.use('/v1', embeddingsRouter);
  app.use('/v1', rerankRouter);
  app.use('/v1', proxyRouter);

  // Health check
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
