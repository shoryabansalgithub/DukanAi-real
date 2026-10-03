import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Payments', feature: 'Configuration', version: '1.0.0', description: 'PaymentsConfig Domain' })
export class PaymentsConfig {
  @IsOptional()
  @IsString()
  stripeSecret?: string;
}
