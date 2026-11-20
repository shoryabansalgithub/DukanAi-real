import { CronJob } from 'cron';
import { CronConfig } from '../../config/domains/cron.config';

/**
 * The one way a scheduler builds its `CronJob`: the expression is read in
 * `CRON_TIMEZONE` (`CronConfig.timeZone`, default Asia/Kolkata), never in the
 * container's zone. The images run in UTC, so a bare `new CronJob('30 1 * *
 * *', ...)` fired the nightly reconciliation at 07:00 in India with the shops
 * open, the analytics at 05:30 and the retention sweep at 09:00. The job is
 * returned stopped: the caller registers it and starts it.
 */
export function createCronJob(cronTime: string, onTick: () => void, cronConfig: Pick<CronConfig, 'timeZone'>): CronJob {
  return CronJob.from({ cronTime, onTick, start: false, timeZone: cronConfig.timeZone });
}
