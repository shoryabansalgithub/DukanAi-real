import { Injectable } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IntegerFromEnv } from '../hydrate-from-env';

/** Worker concurrency. Hydrated with `hydrateFromEnv`. */
@Injectable()
@ConfigDomain({ owner: 'Queue', feature: 'Configuration', version: '2.0.0', description: 'QueueConfig Domain' })
export class QueueConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('QUEUE_CONCURRENCY')
  defaultConcurrency: number = 5;
}
