import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsString } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'Oauth', feature: 'Configuration', version: '1.0.0', description: 'OauthConfig Domain' })
export class OAuthConfig {
  @IsOptional()
  @IsString()
  googleClientId?: string;
}
