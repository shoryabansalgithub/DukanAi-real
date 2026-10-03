import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsNumber } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Performance', feature: 'Configuration', version: '1.0.0', description: 'PerformanceConfig Domain' })
export class PerformanceConfig {
  @IsOptional()
  @IsNumber()
  maxMemory?: number;
}
