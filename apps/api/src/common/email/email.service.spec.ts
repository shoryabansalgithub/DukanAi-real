import { EmailConfig } from '../../config/domains/email.config';
import { EmailService, EmailTransport } from './email.service';

describe('EmailService', () => {
  const message = { to: 'someone@example.com', subject: 'Hello', text: 'Body' };

  it('sends through the transport with the configured From header', async () => {
    const transport: EmailTransport = { sendMail: jest.fn().mockResolvedValue({}) };
    const config = Object.assign(new EmailConfig(), { smtpUrl: 'smtp://user:pass@mail.example.com:587', from: 'Shop <no-reply@example.com>' });
    const service = new EmailService(config, transport);

    expect(service.isConfigured).toBe(true);
    await service.send(message);
    expect(transport.sendMail).toHaveBeenCalledWith({ from: 'Shop <no-reply@example.com>', ...message });
  });

  it('logs instead of sending when SMTP_URL is unset, and says so', async () => {
    const service = new EmailService(new EmailConfig());
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    expect(service.isConfigured).toBe(false);
    await expect(service.send(message)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('someone@example.com'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Body'));
  });

  it('builds a nodemailer transport from SMTP_URL', () => {
    const service = new EmailService(Object.assign(new EmailConfig(), { smtpUrl: 'smtp://user:pass@mail.example.com:587' }));
    expect(service.isConfigured).toBe(true);
  });
});
