import { ArrayMinSize, IsArray, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class CreateWebhookEndpointDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  url: string;

  /** HMAC secret for deliveries; generated server-side when omitted. */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  secret?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
