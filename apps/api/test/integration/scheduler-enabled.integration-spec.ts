import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CronConfig } from '../../src/config/domains/cron.config';
import { bootApp } from './pos-fixtures';

/**
 * Counterpart of scheduler-disabled.integration-spec.ts: with the switch on,
 * every scheduler registers its job on the configured schedule. The schedule
 * is valid with an upcoming run (29 February) so the jobs start but cannot
 * fire while the suite runs.
 */
describe('background schedulers with CRON_ENABLED=true', () => {
  const FAR_AWAY = '0 0 0 29 2 *';
  const SCHEDULERS = [
    'AnalyticsJob',
    'BatchExpirySweep',
    'EventsOutboxRelayService',
    'InventoryRecon',
    'OutboxReaper',
    'ProductOutboxProcessorWorker',
    'PurchaseOutboxRelayCron',
    'Reconciliation',
    'ReservationExpirySweep',
    'RetentionSweep',
  ];
  let app: INestApplication;

  beforeAll(async () => {
    const config = Object.assign(new CronConfig(), {
      enabled: true,
      purchaseOutboxRelayCron: FAR_AWAY,
      eventsOutboxRelayCron: FAR_AWAY,
      productOutboxRelayCron: FAR_AWAY,
      outboxReaperCron: FAR_AWAY,
      inventoryReconCron: FAR_AWAY,
      analyticsJobCron: FAR_AWAY,
      batchExpirySweepCron: FAR_AWAY,
      reservationExpirySweepCron: FAR_AWAY,
      retentionSweepCron: FAR_AWAY,
      reconciliationCron: FAR_AWAY,
    });
    app = await bootApp((builder) => builder.overrideProvider(CronConfig).useValue(config));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers every scheduler on its configured schedule', () => {
    const jobs = app.get(SchedulerRegistry).getCronJobs();
    expect([...jobs.keys()].sort()).toEqual(SCHEDULERS);
    for (const [name, job] of jobs) {
      expect({ name, source: (job as CronJob).cronTime.source }).toEqual({ name, source: FAR_AWAY });
    }
  });
});
