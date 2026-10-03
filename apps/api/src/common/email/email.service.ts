import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { EmailConfig } from '../../config/domains/email.config';
import { isProductionEnv } from '../../config/validation/env-rules';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/** The transport surface this service needs; nodemailer's Transporter satisfies it. */
export type EmailTransport = Pick<Transporter, 'sendMail'>;

/**
 * Sends email through the configured SMTP transport. Without `SMTP_URL` it
 * runs in log mode: every message is written to the log at warn level so a
 * developer can pick up the token or link from the console. `isConfigured`
 * tells callers whether a message will actually leave the process, so that
 * flows which must not fall back to logging (invitations in production) can
 * refuse instead.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport: EmailTransport | null;

  constructor(
    private readonly config: EmailConfig,
    transport?: EmailTransport,
  ) {
    this.transport = transport ?? (config.smtpUrl ? createTransport(config.smtpUrl) : null);
    if (!this.transport) {
      this.logger.warn(
        isProductionEnv()
          ? 'SMTP_URL is not set: email cannot be sent; flows that require delivery (invitations) will refuse'
          : 'SMTP_URL is not set: email is logged instead of sent',
      );
    }
  }

  /** True when messages are actually delivered rather than logged. */
  get isConfigured(): boolean {
    return this.transport !== null;
  }

  async send(message: OutboundEmail): Promise<void> {
    if (!this.transport) {
      this.logger.warn(`[email not sent, SMTP_URL unset] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
      return;
    }
    await this.transport.sendMail({ from: this.config.from, to: message.to, subject: message.subject, text: message.text });
    this.logger.log(`Email sent to ${message.to}: ${message.subject}`);
  }
}
