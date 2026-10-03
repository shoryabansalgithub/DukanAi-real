import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Analytics', feature: 'Configuration', version: '1.0.0', description: 'AnalyticsConfig Domain' })
export class AnalyticsConfig {
  @IsOptional()
  @IsString()
  trackingId?: string;
}
