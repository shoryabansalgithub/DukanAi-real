import * as Sentry from '@sentry/node';
import { MonitoringConfig } from '../../config/domains/monitoring.config';
import { ErrorTracking } from './error-tracking';
import { errorsTrackedTotal } from './metrics';

const mockScope = { setTag: jest.fn(), setUser: jest.fn() };
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  withScope: jest.fn((callback: (scope: unknown) => void) => callback(mockScope)),
  captureException: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

const config = (overrides: Partial<Record<keyof MonitoringConfig, unknown>> = {}) => Object.assign(new MonitoringConfig(), overrides);

describe('ErrorTracking (roadmap 7.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    errorsTrackedTotal.reset();
  });

  it('is a no-op without SENTRY_DSN but still counts every capture', async () => {
    ErrorTracking.init(config(), 'production');
    expect(ErrorTracking.isEnabled).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();

    ErrorTracking.capture(new Error('boom'), { kind: 'unhandled', correlationId: 'c1' });
    await ErrorTracking.flush();

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
    expect((await errorsTrackedTotal.get()).values).toContainEqual(expect.objectContaining({ labels: { kind: 'unhandled' }, value: 1 }));
  });

  it('initialises Sentry with the release and environment and without request data', () => {
    ErrorTracking.init(config({ sentryDsn: 'https://key@o1.ingest.sentry.io/1', appRelease: 'abc123', sentryTracesSampleRate: 0.1 }), 'production');
    expect(ErrorTracking.isEnabled).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://key@o1.ingest.sentry.io/1',
        environment: 'production',
        release: 'abc123',
        tracesSampleRate: 0.1,
        dataCollection: expect.objectContaining({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false }),
      }),
    );
    ErrorTracking.init(config(), 'test');
  });

  it('SENTRY_ENVIRONMENT overrides NODE_ENV as the event environment', () => {
    ErrorTracking.init(config({ sentryDsn: 'https://key@o1.ingest.sentry.io/1', sentryEnvironment: 'staging' }), 'production');
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: 'staging' }));
    ErrorTracking.init(config(), 'test');
  });

  it('tags a captured error with its correlation id, shop, route, status and user', () => {
    ErrorTracking.init(config({ sentryDsn: 'https://key@o1.ingest.sentry.io/1' }), 'production');
    const error = new Error('db down');
    ErrorTracking.capture(error, { kind: 'prisma', correlationId: 'c-9', shopId: 's-1', userId: 'u-1', route: '/api/products/:id', method: 'PATCH', statusCode: 500 });

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(mockScope.setTag.mock.calls).toEqual(
      expect.arrayContaining([
        ['correlationId', 'c-9'],
        ['shopId', 's-1'],
        ['route', '/api/products/:id'],
        ['method', 'PATCH'],
        ['statusCode', '500'],
        ['kind', 'prisma'],
      ]),
    );
    expect(mockScope.setUser).toHaveBeenCalledWith({ id: 'u-1' });
    ErrorTracking.init(config(), 'test');
  });

  it('wraps a non-Error value and never throws when the SDK does', async () => {
    ErrorTracking.init(config({ sentryDsn: 'https://key@o1.ingest.sentry.io/1' }), 'production');
    ErrorTracking.capture('plain string', { kind: 'job' });
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'plain string' }));

    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sdk broke');
    });
    expect(() => ErrorTracking.capture(new Error('x'), { kind: 'startup' })).not.toThrow();

    (Sentry.flush as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await expect(ErrorTracking.flush(10)).resolves.toBeUndefined();
    ErrorTracking.init(config(), 'test');
  });
});
