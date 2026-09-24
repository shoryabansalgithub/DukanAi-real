// Integration tests boot the real AppModule against a real MySQL + Redis.
// NODE_ENV=test makes EnterpriseConfigModule load apps/api/.env.test, whose
// DATABASE_URL / REDIS_URL point at the local test instances. Override with
// TEST_DATABASE_URL / TEST_REDIS_URL when running elsewhere.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;
process.env.PRISMA_LOG_QUERIES = 'false';
// Background schedulers never fire during a suite ('0 0 31 2 *' = 31 February).
// They would otherwise process events committed by earlier tests while a
// test compares database snapshots taken before and after a request (the
// failure-injection suite). Suites that cover the outbox drive
// OutboxRelayService.relayEvents() explicitly.
const NEVER = '0 0 31 2 *';
for (const key of [
  'CRON_INVENTORY_RECON',
  'CRON_ANALYTICS_JOB',
  'CRON_EVENTS_OUTBOX_RELAY',
  'CRON_SALES_OUTBOX_RELAY',
  'CRON_PURCHASE_OUTBOX_RELAY',
  'CRON_PRODUCT_OUTBOX_RELAY',
]) {
  process.env[key] = process.env[key] || NEVER;
}
