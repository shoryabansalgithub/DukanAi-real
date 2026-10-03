import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsBoolean } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Swagger', feature: 'Configuration', version: '1.0.0', description: 'SwaggerConfig Domain' })
export class SwaggerConfig {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
