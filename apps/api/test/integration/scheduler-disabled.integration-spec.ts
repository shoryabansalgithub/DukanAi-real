import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronConfig } from '../../src/config/domains/cron.config';
import { bootApp } from './pos-fixtures';

/**
 * The integration setup file sets CRON_ENABLED=false so background relays
 * cannot write rows in the middle of another suite's before/after snapshot.
 * This proves the running app honours it: if a scheduler stops reading
 * CronConfig, or CronConfig stops reading the environment, the
 * failure-injection suite becomes flaky again. The enabled path is covered by
 * scheduler-enabled.integration-spec.ts (one app boot per file, like every suite).
 */
describe('background schedulers with CRON_ENABLED=false', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers no cron job', () => {
    expect(process.env.CRON_ENABLED).toBe('false');
    expect(app.get(CronConfig).enabled).toBe(false);
    expect(app.get(SchedulerRegistry).getCronJobs().size).toBe(0);
  });
});
