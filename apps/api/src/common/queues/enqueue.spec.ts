import * as net from 'net';
import { Queue } from 'bullmq';
import { enqueueWithin, QueueUnavailableException } from './enqueue';

/**
 * Audit R5: a request that queues a job must not hang while Redis is away.
 * A real BullMQ queue whose Redis never answers (a port nothing listens on)
 * keeps `add` pending for good; `enqueueWithin` answers 503 within its budget.
 */
describe('enqueueWithin', () => {
  let port: number;

  beforeAll(async () => {
    port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
  });

  // The closed client's last reconnect timer: let it end so jest exits on time.
  afterAll(() => new Promise((r) => setTimeout(r, 2_000)));

  it('answers QUEUE_UNAVAILABLE within the budget when Redis does not take the job', async () => {
    const queue = new Queue('enqueue-spec', { connection: { host: '127.0.0.1', port, maxRetriesPerRequest: null, retryStrategy: () => 200 } });
    queue.on('error', () => undefined);
    try {
      const started = Date.now();
      const error = await enqueueWithin(queue, 'job', { a: 1 }, undefined, 300).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueueUnavailableException);
      expect((error as QueueUnavailableException).getStatus()).toBe(503);
      expect((error as QueueUnavailableException).getResponse()).toMatchObject({ code: 'QUEUE_UNAVAILABLE', details: { queue: 'enqueue-spec' } });
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it('maps a rejected add to QUEUE_UNAVAILABLE and passes a successful one through', async () => {
    const failing = { name: 'q', add: jest.fn(async () => Promise.reject(new Error('Connection is closed.'))) };
    await expect(enqueueWithin(failing as never, 'job', {}, undefined, 1_000)).rejects.toBeInstanceOf(QueueUnavailableException);
    const working = { name: 'q', add: jest.fn(async () => ({ id: '7' })) };
    await expect(enqueueWithin(working as never, 'job', { x: 1 }, { jobId: 'j' }, 1_000)).resolves.toEqual({ id: '7' });
    expect(working.add).toHaveBeenCalledWith('job', { x: 1 }, { jobId: 'j' });
  });
});
