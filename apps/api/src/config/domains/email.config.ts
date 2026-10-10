import { Injectable } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { StringFromEnv } from '../hydrate-from-env';

/**
 * Outbound email (invitations). `SMTP_URL` is a nodemailer transport URL
 * (`smtp://user:pass@host:587`, `smtps://...`). Without it `EmailService`
 * logs each message instead of sending it, which production refuses to rely
 * on: an invitation cannot be issued there until SMTP is configured.
 */
@Injectable()
@ConfigDomain({ owner: 'Email', feature: 'Configuration', version: '2.0.0', description: 'EmailConfig Domain' })
export class EmailConfig {
  @IsOptional()
  @IsString()
  @Matches(/^smtps?:\/\/.+/, { message: 'SMTP_URL must be an smtp:// or smtps:// URL' })
  @StringFromEnv()
  @EnvVariable('SMTP_URL')
  readonly smtpUrl?: string;

  /** The From header of every message. */
  @IsString()
  @StringFromEnv()
  @EnvVariable('EMAIL_FROM')
  readonly from: string = 'DukaanAI <no-reply@dukaanai.local>';
}
