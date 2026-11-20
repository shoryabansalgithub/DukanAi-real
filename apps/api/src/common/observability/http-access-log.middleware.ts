import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { CorrelatedRequest } from '../middleware/correlation-id.middleware';
import { routeLabel } from './metrics';

/**
 * One JSON access line per HTTP answer (roadmap 9.10): method, path, route
 * pattern, status, duration, the signed-in user (when one is) and the
 * request's correlation id, so a client's
 * quoted `x-correlation-id` finds the request in the log store even when
 * nothing else logged (`deploy/grafana/dashboards/dukaanai-logs.json`).
 * Registered with `app.use` in main.ts next to the metrics middleware, so
 * guard rejections (401 / 403 / 429) are recorded too, and a request whose
 * connection closed before its answer is logged at warn as `status: "aborted"`. The probes and the
 * scrape are silent: they would be most of the lines and say nothing.
 */
const QUIET_PATHS = [/^\/api\/health(\/|$)/, /^\/api\/metrics$/];
const logger = new Logger('HttpAccess');

export function httpAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const line = (status: number | 'aborted') => {
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (QUIET_PATHS.some((quiet) => quiet.test(path))) return;
    const route = routeLabel(req.baseUrl, (req.route as { path?: string | string[] } | undefined)?.path);
    const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100;
    const entry = {
      event: 'http',
      method: req.method,
      path,
      route,
      status,
      ms,
      ip: req.ip,
      // Set by the JWT guard before the handler ran; absent on anonymous and refused requests.
      userId: (req as { user?: { id?: string } }).user?.id,
      correlationId: (req as CorrelatedRequest).correlationId,
    };
    if (status === 'aborted') logger.warn(entry);
    else logger.log(entry);
  };
  res.once('finish', () => line(res.statusCode));
  // The connection closed before the answer went out (audit R13): the client
  // or the edge gave up. One warn line, so a request the edge timed out is
  // visible next to the work the API went on doing for it.
  res.once('close', () => {
    if (!res.writableFinished) line('aborted');
  });
  next();
}
