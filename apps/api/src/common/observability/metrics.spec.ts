import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';
import { httpMetricsMiddleware } from './http-metrics.middleware';
import { httpRequestDurationSeconds, httpRequestsAbortedTotal, httpRequestsTotal, metricsRegistry, routeLabel, statusLabel } from './metrics';

describe('metrics (roadmap 7.6)', () => {
  it('labels a matched route by its Express pattern and an unmatched request as such', () => {
    expect(routeLabel('', '/api/products/:id')).toBe('/api/products/:id');
    expect(routeLabel('/api', ['/x', '/y'])).toBe('/api/x');
    expect(routeLabel(undefined, undefined)).toBe('unmatched');
    expect(routeLabel('', '/')).toBe('/');
    expect(routeLabel('', '/api/health/')).toBe('/api/health');
    expect(statusLabel(503)).toBe('503');
    expect(statusLabel(Number.NaN)).toBe('0');
  });

  it('the middleware records every finished response under the route pattern and status code', async () => {
    const res = Object.assign(new EventEmitter(), { statusCode: 401 });
    const req = { method: 'GET', baseUrl: '', route: undefined as { path?: string } | undefined };
    const next: NextFunction = jest.fn();

    httpMetricsMiddleware(req as unknown as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    // Express sets req.route when the router matches, after this middleware called next().
    req.route = { path: '/api/products/:id' };
    res.emit('finish');

    const counter = await httpRequestsTotal.get();
    expect(counter.values).toContainEqual(
      expect.objectContaining({ labels: expect.objectContaining({ method: 'GET', route: '/api/products/:id', status: '401' }), value: 1 }),
    );
    const histogram = await httpRequestDurationSeconds.get();
    expect(histogram.values).toContainEqual(
      expect.objectContaining({ metricName: 'http_request_duration_seconds_count', labels: expect.objectContaining({ route: '/api/products/:id' }), value: 1 }),
    );
  });

  it('an unrouted request (404 scanner noise) is one label, not one series per path', async () => {
    for (const url of ['/wp-admin', '/.env', '/api/nope']) {
      const res = Object.assign(new EventEmitter(), { statusCode: 404 });
      httpMetricsMiddleware({ method: 'GET', url, baseUrl: '' } as unknown as Request, res as unknown as Response, jest.fn());
      res.emit('finish');
    }
    const counter = await httpRequestsTotal.get();
    expect(counter.values).toContainEqual(expect.objectContaining({ labels: expect.objectContaining({ route: 'unmatched', status: '404' }), value: 3 }));
  });

  it('counts a request whose connection closed before the answer as aborted, not as answered (audit R13)', async () => {
    const before = (await httpRequestsTotal.get()).values.reduce((n, v) => n + v.value, 0);
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    httpMetricsMiddleware({ method: 'POST', baseUrl: '', route: { path: '/api/billing/invoice' } } as unknown as Request, res as unknown as Response, jest.fn());
    res.emit('close');
    const aborted = await httpRequestsAbortedTotal.get();
    expect(aborted.values).toContainEqual(expect.objectContaining({ labels: expect.objectContaining({ method: 'POST', route: '/api/billing/invoice' }), value: 1 }));
    expect((await httpRequestsTotal.get()).values.reduce((n, v) => n + v.value, 0)).toBe(before);
    // A finished answer's close is not an abort.
    const done = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    httpMetricsMiddleware({ method: 'POST', baseUrl: '', route: { path: '/api/billing/invoice' } } as unknown as Request, done as unknown as Response, jest.fn());
    done.emit('finish');
    done.writableFinished = true;
    done.emit('close');
    expect((await httpRequestsAbortedTotal.get()).values.find((v) => v.labels.route === '/api/billing/invoice')?.value).toBe(1);
  });

  it('renders the registry in the Prometheus text format with the service label and the process metrics', async () => {
    const text = await metricsRegistry.metrics();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toMatch(/http_requests_total\{[^}]*service="dukaanai-api"[^}]*\} 1\n/);
    expect(text).toContain('# TYPE checkout_duration_seconds histogram');
    expect(text).toContain('# TYPE ledger_posting_failures_total counter');
    expect(text).toContain('# TYPE outbox_oldest_pending_age_seconds gauge');
    expect(text).toContain('# TYPE queue_jobs gauge');
    expect(text).toContain('# TYPE retention_rows_purged_total counter');
    expect(text).toContain('dukaanai_process_cpu_seconds_total');
  });
});
