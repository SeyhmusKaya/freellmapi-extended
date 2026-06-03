import { Router } from 'express';
import { listBatchesHandler, getBatchHandler, cancelBatchHandler, resultsBatchHandler } from './batches.js';

/**
 * Admin batches router for the SPA dashboard. No Bearer auth — the dashboard
 * lives behind nginx Basic Auth in production. Read-only + cancel. Batch
 * creation stays on /v1/batches (Bearer) so external callers can't sneak
 * through.
 */
export const adminBatchesRouter = Router();

adminBatchesRouter.get('/', listBatchesHandler);
adminBatchesRouter.get('/:id', getBatchHandler);
adminBatchesRouter.get('/:id/results', resultsBatchHandler);
adminBatchesRouter.delete('/:id', cancelBatchHandler);
