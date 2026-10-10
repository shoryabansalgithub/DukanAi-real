import { EmailConfig } from '../../config/domains/email.config';
import { emailMessagesTotal } from '../observability/metrics';
import { EmailService, EmailTransport, OutboundEmail } from './email.service';

describe('EmailService', () => {
  const message: OutboundEmail = { purpose: 'invitation', to: 'someone@example.com', subject: 'Hello', text: 'Body' };
  const counted = async (outcome: string) =>
    (await emailMessagesTotal.get()).values.find((v) => v.labels.purpose === 'invitation' && v.labels.outcome === outcome)?.value ?? 0;

  it('sends through the transport with the configured From header', async () => {
    const transport: EmailTransport = { sendMail: jest.fn().mockResolvedValue({}) };
    const config = Object.assign(new EmailConfig(), { smtpUrl: 'smtp://user:pass@mail.example.com:587', from: 'Shop <no-reply@example.com>' });
    const service = new EmailService(config, transport);
    const before = await counted('sent');

    expect(service.isConfigured).toBe(true);
    await service.send(message);
    expect(transport.sendMail).toHaveBeenCalledWith({ from: 'Shop <no-reply@example.com>', to: message.to, subject: message.subject, text: message.text });
    expect(await counted('sent')).toBe(before + 1);
  });

  it('logs instead of sending when SMTP_URL is unset, and says so', async () => {
    const service = new EmailService(new EmailConfig());
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    const before = await counted('logged');

    expect(service.isConfigured).toBe(false);
    await expect(service.send(message)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('someone@example.com'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Body'));
    expect(await counted('logged')).toBe(before + 1);
  });

  it('a relay refusal is logged with the relay reply, counted as failed and rethrown to the caller', async () => {
    const refusal = Object.assign(new Error("Can't send mail - all recipients were rejected"), {
      code: 'EENVELOPE',
      responseCode: 550,
      response: '550 5.7.1 mailbox unavailable',
    });
    const transport: EmailTransport = { sendMail: jest.fn().mockRejectedValue(refusal) };
    const service = new EmailService(Object.assign(new EmailConfig(), { smtpUrl: 'smtp://mail.example.com:587' }), transport);
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    const before = await counted('failed');

    await expect(service.send(message)).rejects.toBe(refusal);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('550 5.7.1 mailbox unavailable'));
    expect(error).toHaveBeenCalledWith(expect.not.stringContaining('Body'));
    expect(await counted('failed')).toBe(before + 1);
  });

  it('builds a nodemailer transport from SMTP_URL', () => {
    const service = new EmailService(Object.assign(new EmailConfig(), { smtpUrl: 'smtp://user:pass@mail.example.com:587' }));
    expect(service.isConfigured).toBe(true);
  });
});
