// Integration tests boot the real AppModule against a real MySQL + Redis.
// NODE_ENV=test makes EnterpriseConfigModule load apps/api/.env.test, whose
// DATABASE_URL / REDIS_URL point at the local test instances. Override with
// TEST_DATABASE_URL / TEST_REDIS_URL when running elsewhere.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;
process.env.PRISMA_LOG_QUERIES = 'false';
// Background schedulers stay off during a suite (CronConfig.enabled = false).
// They would otherwise process events committed by earlier tests while a
// test compares database snapshots taken before and after a request (the
// failure-injection suite). Suites that cover the outbox drive
// OutboxRelayService.relayEvents() explicitly. Note: a cron expression that
// never occurs is not an alternative, CronJob.start() throws on it.
process.env.CRON_ENABLED = process.env.CRON_ENABLED ?? 'false';
