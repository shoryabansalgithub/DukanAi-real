import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { httpAccessLogMiddleware } from './http-access-log.middleware';

function fakeRequest(overrides: Partial<Request> & { correlationId?: string }): Request {
  return { method: 'GET', originalUrl: '/api/products?q=tea', url: '/api/products?q=tea', baseUrl: '', ip: '203.0.113.9', ...overrides } as unknown as Request;
}

function fakeResponse(statusCode: number): Response {
  const emitter = new EventEmitter() as EventEmitter & { statusCode: number };
  emitter.statusCode = statusCode;
  return emitter as unknown as Response;
}

describe('httpAccessLogMiddleware', () => {
  const lines: unknown[] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    lines.length = 0;
    spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(message);
    });
  });
  afterEach(() => spy.mockRestore());

  it('logs one line per finished answer with the route pattern, status, duration and correlation id', () => {
    const req = fakeRequest({ correlationId: 'corr-42', route: { path: '/:id' } as never, baseUrl: '/api/products', user: { id: 'user-7' } as never });
    const res = fakeResponse(404);
    const next = jest.fn();
    httpAccessLogMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(0);
    res.emit('finish');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'http', method: 'GET', path: '/api/products', route: '/api/products/:id', status: 404, ip: '203.0.113.9', userId: 'user-7', correlationId: 'corr-42' });
    expect(typeof (lines[0] as { ms: number }).ms).toBe('number');
  });

  it('stays silent for the probes and the scrape', () => {
    for (const url of ['/api/health', '/api/health/ready', '/api/health/live?x=1', '/api/metrics']) {
      const res = fakeResponse(200);
      httpAccessLogMiddleware(fakeRequest({ originalUrl: url, url }), res, jest.fn());
      res.emit('finish');
    }
    expect(lines).toHaveLength(0);
  });

  it('records a guard rejection that never reached a route (no route pattern)', () => {
    const res = fakeResponse(401);
    httpAccessLogMiddleware(fakeRequest({ correlationId: 'corr-1', originalUrl: '/api/products', url: '/api/products' }), res, jest.fn());
    res.emit('finish');
    expect(lines[0]).toMatchObject({ status: 401, path: '/api/products', correlationId: 'corr-1' });
  });
});
