import { Injectable } from '@nestjs/common';
import { IsBoolean, IsString, registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { CronTime, validateCronExpression } from 'cron';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv, StringFromEnv } from '../hydrate-from-env';

/**
 * Accepts the 5- or 6-field expressions the `cron` package runs, and only
 * those with an upcoming execution date: `CronJob.start()` throws for a
 * schedule that never occurs (e.g. `0 0 31 2 *`), which would take the whole
 * app down inside a bootstrap hook. Use `CRON_ENABLED=false` to switch the
 * schedulers off instead.
 */
export function IsCronExpression(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isCronExpression',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'string' || !validateCronExpression(value).valid) return false;
          try {
            new CronTime(value).sendAt();
            return true;
          } catch {
            return false; // no execution date in the next 8 years
          }
        },
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} must be a valid cron expression with an upcoming run (got ${JSON.stringify(args.value)})`,
      },
    });
  };
}

/**
 * Background job schedules. Hydrated with `hydrateFromEnv`: an unset or blank
 * variable keeps the default, an invalid expression fails boot.
 * `CRON_ENABLED=false` registers no schedule at all (integration tests rely on
 * this so relays cannot write rows during another suite's snapshot).
 */
@Injectable()
@ConfigDomain({ owner: 'Cron', feature: 'Configuration', version: '1.0.0', description: 'CronConfig Domain' })
export class CronConfig {
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('CRON_ENABLED')
  enabled: boolean = true;

  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_PURCHASE_OUTBOX_RELAY')
  purchaseOutboxRelayCron: string = '* * * * * *'; // EVERY_SECOND

  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_EVENTS_OUTBOX_RELAY')
  eventsOutboxRelayCron: string = '*/5 * * * * *'; // EVERY_5_SECONDS

  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_PRODUCT_OUTBOX_RELAY')
  productOutboxRelayCron: string = '* * * * * *'; // EVERY_SECOND

  /** Stale-claim reaper for every outbox relay (roadmap 4.7), under a cron lock. */
  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_OUTBOX_REAPER')
  outboxReaperCron: string = '* * * * *'; // EVERY_MINUTE

  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_INVENTORY_RECON')
  inventoryReconCron: string = '*/5 * * * *'; // EVERY_5_MINUTES

  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_ANALYTICS_JOB')
  analyticsJobCron: string = '0 0 * * *'; // EVERY_DAY_AT_MIDNIGHT

  /** Global batch-expiry sweep (every shop, under a cron lock). Expiry dates are days, so hourly is plenty. */
  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_BATCH_EXPIRY_SWEEP')
  batchExpirySweepCron: string = '0 * * * *'; // EVERY_HOUR

  /** Global reservation-expiry sweep (every shop, under a cron lock). Reservations expire by the second. */
  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_RESERVATION_EXPIRY_SWEEP')
  reservationExpirySweepCron: string = '* * * * *'; // EVERY_MINUTE

  /** Nightly retention sweep (roadmap 7.8): expired tokens, DONE outbox rows, old SearchHistory / ProductEventLog, under a cron lock. */
  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_RETENTION_SWEEP')
  retentionSweepCron: string = '30 3 * * *'; // EVERY_DAY_AT_03:30

  /**
   * Nightly financial reconciliation (roadmap 9.5): every shop's previous
   * business day, under a cron lock. Schedule it after the latest shop
   * timezone has passed midnight (01:30 server time suits Asia/Kolkata on a
   * UTC or IST server).
   */
  @IsString()
  @IsCronExpression()
  @StringFromEnv()
  @EnvVariable('CRON_RECONCILIATION')
  reconciliationCron: string = '30 1 * * *'; // EVERY_DAY_AT_01:30
}
