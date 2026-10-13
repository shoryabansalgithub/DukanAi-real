import type { NextFunction, Request, Response } from 'express';
import { httpRequestDurationSeconds, httpRequestsAbortedTotal, httpRequestsTotal, routeLabel, statusLabel } from './metrics';

/**
 * Records every HTTP answer, guard rejections included (an interceptor runs
 * after the guards, so a 401 would never reach it). Registered with
 * `app.use` in main.ts before the routers; the route pattern is known only
 * once the response finishes. A request whose connection closed before the
 * answer was sent (`close` without `finish`: the client or the edge gave up)
 * is counted in `http_requests_aborted_total` instead (audit R13).
 */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const route = () => routeLabel(req.baseUrl, (req.route as { path?: string | string[] } | undefined)?.path);
  res.once('finish', () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    httpRequestsTotal.inc({ method: req.method, route: route(), status: statusLabel(res.statusCode) });
    httpRequestDurationSeconds.observe({ method: req.method, route: route() }, seconds);
  });
  res.once('close', () => {
    if (!res.writableFinished) httpRequestsAbortedTotal.inc({ method: req.method, route: route() });
  });
  next();
}
