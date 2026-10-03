import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsNumber } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Health', feature: 'Configuration', version: '1.0.0', description: 'HealthConfig Domain' })
export class HealthConfig {
  @IsOptional()
  @IsNumber()
  checkInterval?: number;
}
