import { WorkerHost } from '@nestjs/bullmq';
import { GracefulShutdownService } from './graceful-shutdown.service';

class StubWorkerHost extends WorkerHost {
  constructor(public readonly closeFn: jest.Mock) {
    super();
    (this as unknown as { _worker: unknown })._worker = { close: closeFn, waitUntilReady: jest.fn() };
  }
  process(): Promise<void> {
    return Promise.resolve();
  }
}

/** A ModulesContainer with one module holding the given provider instances. */
function modulesWith(...instances: unknown[]) {
  const providers = new Map(instances.map((instance, i) => [`p${i}`, { instance }]));
  return new Map([['m', { providers }]]) as never;
}

describe('GracefulShutdownService (roadmap 7.3)', () => {
  const config = (overrides: Partial<{ shutdownTimeoutMs: number; shutdownDrainDelayMs: number }> = {}) =>
    ({ shutdownTimeoutMs: 30_000, shutdownDrainDelayMs: 0, ...overrides }) as never;

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('flips to draining first, then closes every BullMQ worker, once', async () => {
    const closeA = jest.fn().mockResolvedValue(undefined);
    const closeB = jest.fn().mockRejectedValue(new Error('already closed'));
    const service = new GracefulShutdownService(modulesWith(new StubWorkerHost(closeA), new StubWorkerHost(closeB), {}), config());
    expect(service.isDraining).toBe(false);

    await service.beforeApplicationShutdown();
    expect(service.isDraining).toBe(true);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);

    await service.beforeApplicationShutdown('SIGTERM');
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it('on a signal, waits the drain delay before closing the workers and arms the watchdog', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const close = jest.fn().mockResolvedValue(undefined);
    const service = new GracefulShutdownService(modulesWith(new StubWorkerHost(close)), config({ shutdownDrainDelayMs: 2_000, shutdownTimeoutMs: 5_000 }));

    const pending = service.beforeApplicationShutdown('SIGTERM');
    expect(service.isDraining).toBe(true);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(close).toHaveBeenCalledTimes(1);

    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('without a signal (app.close() in tests) there is no delay and no watchdog', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const service = new GracefulShutdownService(modulesWith(), config({ shutdownDrainDelayMs: 2_000, shutdownTimeoutMs: 1_000 }));
    await service.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
