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

/** Longest subject a message is sent with. */
export const MAX_EMAIL_SUBJECT_LENGTH = 200;

/**
 * User-supplied text (a shop's name, a person's name) for a subject or a
 * line of a body (audit R15): one line (CR, LF and every other control
 * character become a space), collapsed, trimmed and capped. A shop named
 * "Ravi\r\nBcc: ..." or "Ravi\n\nClick http://..." cannot add a header or
 * lines of its own to a message DukaanAI sends.
 */
export function emailSafeText(value: string | null | undefined, maxLength = 100): string {
  // eslint-disable-next-line no-control-regex
  const flat = (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : flat;
}

/** A recipient for a log line: the first character of the local part and the domain (`o***@example.com`). */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}

/** A body as plain text: CRLF and lone CR become LF; other control characters except tab go. */
function plainTextBody(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

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
    // Every step of a send is bounded (audit R8); options in the URL's query still win.
    this.transport =
      transport ??
      (config.smtpUrl
        ? createTransport({ url: config.smtpUrl, connectionTimeout: config.smtpTimeoutMs, greetingTimeout: config.smtpTimeoutMs, socketTimeout: config.smtpTimeoutMs })
        : null);
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
    // The subject is one line of bounded length and the body plain text, whatever a caller interpolated.
    const subject = emailSafeText(message.subject, MAX_EMAIL_SUBJECT_LENGTH);
    const text = plainTextBody(message.text);
    // Log lines name the recipient masked (audit R15): logs leave the process (Loki, Sentry breadcrumbs).
    const to = maskEmail(message.to);
    if (!this.transport) {
      emailMessagesTotal.inc({ purpose: message.purpose, outcome: 'logged' });
      // Development only (production refuses the flows that need delivery): the body carries the link a developer needs.
      this.logger.warn(`[email not sent, SMTP_URL unset] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
      return;
    }
    try {
      await this.transport.sendMail({ from: this.config.from, to: message.to, subject, text });
    } catch (err) {
      emailMessagesTotal.inc({ purpose: message.purpose, outcome: 'failed' });
      this.logger.error(`Email (${message.purpose}) to ${to} was not accepted by the relay: ${describeSmtpError(err)}`);
      throw err;
    }
    emailMessagesTotal.inc({ purpose: message.purpose, outcome: 'sent' });
    this.logger.log(`Email (${message.purpose}) sent to ${to}`);
  }
}

/** The relay's own words (nodemailer puts the SMTP reply in `response`), without the message body. */
function describeSmtpError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, responseCode, response } = err as Error & { code?: string; responseCode?: number; response?: string };
  return [code, responseCode, response ?? err.message].filter((part) => part !== undefined && part !== '').join(' ');
}
