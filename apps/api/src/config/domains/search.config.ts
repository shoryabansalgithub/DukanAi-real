import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Search', feature: 'Configuration', version: '1.0.0', description: 'SearchConfig Domain' })
export class SearchConfig {
  @IsOptional()
  @IsString()
  elasticsearchUrl?: string;
}
