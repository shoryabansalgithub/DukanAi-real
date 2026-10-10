import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { EmailConfig } from '../../config/domains/email.config';
import { isProductionEnv } from '../../config/validation/env-rules';
import { emailMessagesTotal, zeroSeries } from '../observability/metrics';

/** What a message is for: the `purpose` label of `email_messages_total`. */
export const EMAIL_PURPOSES = ['invitation', 'password_reset', 'password_changed'] as const;
export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];

/** The `outcome` label: the relay accepted it, refused it or was unreachable, or no SMTP_URL (logged). */
export const EMAIL_OUTCOMES = ['sent', 'failed', 'logged'] as const;

// The first failed message of each purpose must show in increase() (DukaanAiEmailDeliveryFailing).
zeroSeries(emailMessagesTotal, EMAIL_PURPOSES.flatMap((purpose) => EMAIL_OUTCOMES.map((outcome) => ({ purpose, outcome }))));

export interface OutboundEmail {
  purpose: EmailPurpose;
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
 * refuse instead. A relay failure is logged, counted
 * (`email_messages_total{outcome="failed"}`) and rethrown: the caller decides
 * what the user is told and undoes what the message was for.
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
      emailMessagesTotal.inc({ purpose: message.purpose, outcome: 'logged' });
      this.logger.warn(`[email not sent, SMTP_URL unset] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
      return;
    }
    try {
      await this.transport.sendMail({ from: this.config.from, to: message.to, subject: message.subject, text: message.text });
    } catch (err) {
      emailMessagesTotal.inc({ purpose: message.purpose, outcome: 'failed' });
      this.logger.error(`Email (${message.purpose}) to ${message.to} was not accepted by the relay: ${describeSmtpError(err)}`);
      throw err;
    }
    emailMessagesTotal.inc({ purpose: message.purpose, outcome: 'sent' });
    this.logger.log(`Email sent to ${message.to}: ${message.subject}`);
  }
}

/** The relay's own words (nodemailer puts the SMTP reply in `response`), without the message body. */
function describeSmtpError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, responseCode, response } = err as Error & { code?: string; responseCode?: number; response?: string };
  return [code, responseCode, response ?? err.message].filter((part) => part !== undefined && part !== '').join(' ');
}
