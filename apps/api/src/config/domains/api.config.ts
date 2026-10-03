import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Api', feature: 'Configuration', version: '1.0.0', description: 'ApiConfig Domain' })
export class ApiConfig {
  @IsOptional()
  @IsString()
  baseUrl?: string;
}
