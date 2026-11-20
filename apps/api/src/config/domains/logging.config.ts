import { Injectable } from '@nestjs/common';
import type { LogLevel } from '@nestjs/common';
import { IsIn, registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { StringFromEnv } from '../hydrate-from-env';
import { isProductionEnv } from '../validation/env-rules';

/** Nest log levels from the least to the most verbose. */
export const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/** The levels Nest should print for a configured threshold (`log` prints fatal..log). */
export function logLevelsUpTo(level: LogLevel): LogLevel[] {
  return LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(level) + 1);
}

/** Production must not print debug or verbose output (roadmap 7.6). */
function IsNotDebugInProduction(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isNotDebugInProduction',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => !isProductionEnv() || (value !== 'debug' && value !== 'verbose'),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} is ${JSON.stringify(args.value)}: production prints at most the "log" level (set LOG_LEVEL to fatal, error, warn or log)`,
      },
    });
  };
}

/**
 * Logging (roadmap 7.6). `LOG_LEVEL` is the most verbose level the process
 * prints; the default is `log` in production and `debug` elsewhere, and
 * production refuses `debug` / `verbose`. Every line is JSON with the
 * correlation id (`CorrelationLogger`). Hydrated with `hydrateFromEnv`.
 */
@Injectable()
@ConfigDomain({ owner: 'Logging', feature: 'Configuration', version: '2.0.0', description: 'LoggingConfig Domain' })
export class LoggingConfig {
  @IsIn(LOG_LEVELS as unknown as string[], { message: `logLevel must be one of ${LOG_LEVELS.join(', ')}` })
  @IsNotDebugInProduction()
  @StringFromEnv()
  @EnvVariable('LOG_LEVEL')
  readonly logLevel: LogLevel = isProductionEnv() ? 'log' : 'debug';

  /** The levels to hand to the logger for the configured threshold. */
  get levels(): LogLevel[] {
    return logLevelsUpTo(this.logLevel);
  }
}
