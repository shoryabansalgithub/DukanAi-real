import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';
import { OutboxClaimService } from './outbox-claim.service';

describe('OutboxClaimService (roadmap 4.7)', () => {
  let config: EventsFeatureConfig;
  let updateMany: jest.Mock;
  let findUnique: jest.Mock;
  let service: OutboxClaimService;

  beforeEach(() => {
    config = new EventsFeatureConfig();
    config.outboxRetryBackoffMs = 1000;
    config.outboxRetryBackoffMaxMs = 10_000;
    config.outboxMaxRetries = 3;
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    findUnique = jest.fn();
    service = new OutboxClaimService({ outboxEvent: { updateMany, findUnique } } as never, config);
  });

  it('job ids carry the attempt so a retried row never collides with a retained job', () => {
    expect(service.jobIdFor({ id: 'evt', retryCount: 0 })).toBe('evt.0');
    expect(service.jobIdFor({ id: 'evt', retryCount: 3 })).toBe('evt.3');
    expect(service.jobIdFor({ id: 'evt', retryCount: 3 })).not.toContain(':'); // BullMQ: "Custom Id cannot contain :"
  });

  it('backoff doubles per attempt from the base and is capped', () => {
    expect(service.backoffMs(1)).toBe(1000);
    expect(service.backoffMs(2)).toBe(2000);
    expect(service.backoffMs(4)).toBe(8000);
    expect(service.backoffMs(5)).toBe(10_000);
    expect(service.backoffMs(20)).toBe(10_000);
  });

  it('scheduleRetry moves the row back to PENDING with the next attempt time, then FAILED once the retries are spent', async () => {
    findUnique.mockResolvedValueOnce({ retryCount: 0 });
    const before = Date.now();
    expect(await service.scheduleRetry('evt', 'boom')).toBe('RETRY');
    const data = updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'PENDING', claimedAt: null, retryCount: 1, error: 'boom' });
    expect(data.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(1000);
    expect(data.nextAttemptAt.getTime() - before).toBeLessThan(2500);

    findUnique.mockResolvedValueOnce({ retryCount: 2 });
    expect(await service.scheduleRetry('evt', 'boom again')).toBe('FAILED');
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ status: 'FAILED', error: expect.stringContaining('retries exhausted') });
  });

  it('retryFailed only touches a FAILED row of the shop and bumps the attempt', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await service.retryFailed('shop-1', 'evt')).toBe(false);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: 'evt', shopId: 'shop-1', status: 'FAILED' });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', nextAttemptAt: null, retryCount: { increment: 1 } });
  });
});
