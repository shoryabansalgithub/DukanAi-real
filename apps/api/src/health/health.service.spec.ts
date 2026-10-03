import { HealthService, HEALTH_CHECK_TIMEOUT_MS } from './health.service';

describe('HealthService (roadmap 7.3)', () => {
  const prisma = { $queryRaw: jest.fn() };
  const redis = { ping: jest.fn() };
  const shutdown = { isDraining: false };
  const service = () => new HealthService(prisma as never, redis as never, shutdown as never);

  beforeEach(() => {
    jest.useRealTimers();
    prisma.$queryRaw.mockReset().mockResolvedValue([{ 1: 1 }]);
    redis.ping.mockReset().mockResolvedValue('PONG');
    shutdown.isDraining = false;
  });

  it('liveness never touches a dependency', () => {
    const report = service().liveness();
    expect(report.status).toBe('ok');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it('readiness is ok when the database and Redis answer', async () => {
    await expect(service().readiness()).resolves.toMatchObject({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('a failing dependency makes readiness unavailable and names it', async () => {
    redis.ping.mockRejectedValue(new Error('Connection is closed'));
    await expect(service().readiness()).resolves.toMatchObject({ status: 'unavailable', checks: { database: 'up', redis: 'down' } });
    prisma.$queryRaw.mockRejectedValue(new Error("Can't reach database server"));
    redis.ping.mockResolvedValue('PONG');
    await expect(service().readiness()).resolves.toMatchObject({ status: 'unavailable', checks: { database: 'down', redis: 'up' } });
  });

  it('a dependency that never answers is reported down after the probe timeout', async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockReturnValue(new Promise(() => undefined));
    const pending = service().readiness();
    await jest.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS + 1);
    await expect(pending).resolves.toMatchObject({ status: 'unavailable', checks: { database: 'down', redis: 'up' } });
  });

  it('a draining instance is not ready even when every dependency is up', async () => {
    shutdown.isDraining = true;
    await expect(service().readiness()).resolves.toMatchObject({ status: 'draining', checks: { database: 'up', redis: 'up' } });
  });
});
