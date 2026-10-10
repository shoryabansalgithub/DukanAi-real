import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * ASVS 8.2.1 (roadmap 9.15): every answer of the API is personal or shop data,
 * or a probe nobody should cache, so no browser or intermediary may store it.
 * Registered for every route by `CorrelationModule`, so it applies in the
 * integration fixture exactly as in `main.ts`.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction) {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
}
