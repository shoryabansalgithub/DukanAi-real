import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'FeatureFlags', feature: 'Configuration', version: '1.0.0', description: 'FeatureFlagsConfig Domain' })
export class FeatureFlagsConfig {
  @IsOptional()
  @IsString()
  launchDarklyKey?: string;
}
