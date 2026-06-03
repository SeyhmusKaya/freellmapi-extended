import { Router } from 'express';
import type { Request, Response } from 'express';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

export const modelStatusRouter = Router();

// Daily probe writes this file (see scripts/probe-models.sh + cron).
const STATUS_FILE = path.join(process.cwd(), 'server', 'data', 'model-status.json');
const STATUS_FILE_ALT = path.join(process.cwd(), 'data', 'model-status.json');

modelStatusRouter.get('/', (_req: Request, res: Response) => {
  const file = existsSync(STATUS_FILE) ? STATUS_FILE
    : existsSync(STATUS_FILE_ALT) ? STATUS_FILE_ALT : null;
  if (!file) {
    res.json({ generatedAt: null, ok: 0, fail: 0, total: 0, results: [] });
    return;
  }
  try {
    res.json(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    res.json({ generatedAt: null, ok: 0, fail: 0, total: 0, results: [] });
  }
});
