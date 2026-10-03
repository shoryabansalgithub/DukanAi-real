import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Whatsapp', feature: 'Configuration', version: '1.0.0', description: 'WhatsappConfig Domain' })
export class WhatsappConfig {
  @IsOptional()
  @IsString()
  apiKey?: string;
}
