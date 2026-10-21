import { EmailConfig } from '../../config/domains/email.config';
import { emailMessagesTotal } from '../observability/metrics';
import * as net from 'net';
import { EmailService, EmailTransport, emailSafeText, maskEmail, OutboundEmail } from './email.service';

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
    // The recipient is masked in logs (audit R15); the body (a developer's link) is shown.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s***@example.com'));
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('someone@example.com'));
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

  it('sends a one-line, bounded subject and a plain body, whatever was interpolated (audit R15)', async () => {
    const transport: EmailTransport = { sendMail: jest.fn().mockResolvedValue({}) };
    const service = new EmailService(Object.assign(new EmailConfig(), { smtpUrl: 'smtp://mail.example.com:587' }), transport);
    await service.send({ ...message, subject: `Invited to Ravi\r\nBcc: victim@example.com ${'x'.repeat(400)}`, text: 'line one\r\nline two\u0007' });
    const sent = (transport.sendMail as jest.Mock).mock.calls[0][0] as { subject: string; text: string };
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.subject.startsWith('Invited to Ravi Bcc: victim@example.com')).toBe(true);
    expect([...sent.subject].length).toBeLessThanOrEqual(200);
    expect(sent.text).toBe('line one\nline two');
  });

  it('emailSafeText flattens and caps user text; maskEmail keeps only the first letter and the domain', () => {
    expect(emailSafeText('Ravi\r\n\nStores\u2028Ltd')).toBe('Ravi Stores Ltd');
    expect(emailSafeText(`${'क'.repeat(150)}`, 10)).toBe(`${'क'.repeat(9)}…`);
    expect(emailSafeText(undefined)).toBe('');
    expect(maskEmail('owner-x@test.local')).toBe('o***@test.local');
    expect(maskEmail('not-an-address')).toBe('***');
  });

  it('gives up on a relay that accepts the connection and never greets, within SMTP_TIMEOUT_MS (audit R8)', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const service = new EmailService(Object.assign(new EmailConfig(), { smtpUrl: `smtp://127.0.0.1:${port}`, smtpTimeoutMs: 1000 }));
      jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
      const started = Date.now();
      await expect(service.send(message)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
