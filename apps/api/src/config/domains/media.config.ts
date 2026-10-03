import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsNumber } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Media', feature: 'Configuration', version: '1.0.0', description: 'MediaConfig Domain' })
export class MediaConfig {
  @IsOptional()
  @IsNumber()
  maxSize?: number;
}
