import * as http from 'http';
import type { AddressInfo } from 'net';
import { WebhookDeadlineError, WebhookHttpClient } from './webhook-http-client';

/**
 * The real client against a local receiver (audit R2, R6, R12): non-ASCII
 * bodies are delivered byte-exact, a dripping receiver is cut off at the
 * total deadline, an environment proxy is never used, and the connection
 * goes to the vetted (pinned) address whatever the host name resolves to.
 */
describe('WebhookHttpClient (real HTTP)', () => {
  let server: http.Server;
  let port: number;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;
  const sockets = new Set<import('net').Socket>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks)));
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // The host name does not resolve anywhere: only the pinned address can reach the receiver.
  const target = () => ({ url: new URL(`http://receiver.invalid:${port}/hook`), address: '127.0.0.1', family: 4 as const });
  const client = new WebhookHttpClient();

  it('delivers a Hindi / ₹ payload byte-exact (the size limit counts bytes, not UTF-16 units)', async () => {
    const body = JSON.stringify({ product: 'Parle-G बिस्कुट', price: '₹10', note: 'दुकान' });
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
    let received: { body: string; length: string | undefined } | undefined;
    handler = (req, res, raw) => {
      received = { body: raw.toString('utf8'), length: req.headers['content-length'] };
      res.writeHead(204).end();
    };
    await expect(client.post({ target: target(), body, headers: { 'Content-Type': 'application/json' }, timeoutMs: 5000, maxResponseBytes: 1024 })).resolves.toEqual({ status: 204 });
    expect(received).toEqual({ body, length: String(Buffer.byteLength(body)) });
  });

  it('cuts off a receiver that drips its answer within the total deadline', async () => {
    let timer: NodeJS.Timeout | undefined;
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // One byte every 100 ms: the idle timer never trips.
      timer = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(timer));
    };
    const started = Date.now();
    await expect(client.post({ target: target(), body: '{}', headers: {}, timeoutMs: 1000, maxResponseBytes: 1_000_000 })).rejects.toBeInstanceOf(WebhookDeadlineError);
    expect(Date.now() - started).toBeLessThan(3000);
    clearInterval(timer);
  });

  it('cuts off a receiver that never answers', async () => {
    handler = () => undefined;
    const started = Date.now();
    await expect(client.post({ target: target(), body: '{}', headers: {}, timeoutMs: 1000, maxResponseBytes: 1024 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('never uses a proxy from the environment', async () => {
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
    // A proxy that refuses every connection: a client that honoured it would fail.
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.http_proxy = 'http://127.0.0.1:9';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      handler = (_req, res) => res.writeHead(200).end('ok');
      await expect(client.post({ target: target(), body: '{}', headers: {}, timeoutMs: 3000, maxResponseBytes: 1024 })).resolves.toEqual({ status: 200 });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('a non-2xx answer and a redirect are failed deliveries', async () => {
    handler = (_req, res) => res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    await expect(client.post({ target: target(), body: '{}', headers: {}, timeoutMs: 3000, maxResponseBytes: 1024 })).rejects.toThrow();
    handler = (_req, res) => res.writeHead(500).end();
    await expect(client.post({ target: target(), body: '{}', headers: {}, timeoutMs: 3000, maxResponseBytes: 1024 })).rejects.toThrow();
  });
});
