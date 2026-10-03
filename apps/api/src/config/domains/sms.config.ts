import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Sms', feature: 'Configuration', version: '1.0.0', description: 'SmsConfig Domain' })
export class SmsConfig {
  @IsOptional()
  @IsString()
  twilioSid?: string;
}
