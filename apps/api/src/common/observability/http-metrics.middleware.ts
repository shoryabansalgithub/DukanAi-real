import type { NextFunction, Request, Response } from 'express';
import { httpRequestDurationSeconds, httpRequestsTotal, routeLabel, statusLabel } from './metrics';

/**
 * Records every HTTP answer, guard rejections included (an interceptor runs
 * after the guards, so a 401 would never reach it). Registered with
 * `app.use` in main.ts before the routers; the route pattern is known only
 * once the response finishes.
 */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const route = routeLabel(req.baseUrl, (req.route as { path?: string | string[] } | undefined)?.path);
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    httpRequestsTotal.inc({ method: req.method, route, status: statusLabel(res.statusCode) });
    httpRequestDurationSeconds.observe({ method: req.method, route }, seconds);
  });
  next();
}
