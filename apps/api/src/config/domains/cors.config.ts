import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Cors', feature: 'Configuration', version: '1.0.0', description: 'CorsConfig Domain' })
export class CorsConfig {
  @IsOptional()
  @IsString()
  allowedOrigins?: string;
}
