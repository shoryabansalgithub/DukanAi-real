import { createServer, type Server, type Socket } from 'net';

export interface SunkMessage {
  from: string;
  to: string[];
  /** Header names lower-cased, folded lines joined, encoded words decoded. */
  headers: Record<string, string>;
  /** The body after the transfer encoding is undone. */
  text: string;
}

/**
 * A minimal SMTP relay for integration tests (roadmap 9.19): enough of RFC
 * 5321 for nodemailer (EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT) over
 * loopback, without STARTTLS, so the API's real transport (`SMTP_URL` ->
 * nodemailer) delivers to it exactly as it would to a provider's relay.
 * `refuseRecipients` rehearses a relay that rejects the message.
 */
export class SmtpSink {
  readonly messages: SunkMessage[] = [];
  /** When set, every RCPT TO is answered 550 with this text. */
  refuseRecipients: string | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  get url(): string {
    return `smtp://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Resolves with the first message (kept or arriving) that matches, or rejects after `timeoutMs`. */
  async waitFor(match: (m: SunkMessage) => boolean, timeoutMs = 10_000): Promise<SunkMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`No matching message within ${timeoutMs} ms (${this.messages.length} received)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private session(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let buffer = '';
    let inData = false;
    let data: string[] = [];
    let from = '';
    let to: string[] = [];

    reply('220 smtp-sink ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            this.messages.push(parseMessage(from, to, data.join('\r\n')));
            data = [];
            reply('250 2.0.0 queued');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          reply('250-smtp-sink');
          reply('250-8BITMIME');
          reply('250 SMTPUTF8');
        } else if (verb === 'HELO') reply('250 smtp-sink');
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          reply('250 2.1.0 OK');
        } else if (verb === 'RCPT') {
          if (this.refuseRecipients) reply(`550 5.7.1 ${this.refuseRecipients}`);
          else {
            to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            reply('250 2.1.5 OK');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          from = '';
          to = [];
          reply('250 2.0.0 OK');
        } else if (verb === 'NOOP') reply('250 2.0.0 OK');
        else if (verb === 'QUIT') {
          reply('221 2.0.0 Bye');
          socket.end();
        } else reply('502 5.5.2 Command not recognized');
      }
    });
  }
}

function decodeQuotedPrintable(input: string): string {
  const bytes = input.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

/** RFC 2047 encoded words (`=?UTF-8?Q?...?=`, `=?UTF-8?B?...?=`), as nodemailer writes non-ASCII headers. */
function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([QBqb])\?([^?]*)\?=/g, (_, _charset: string, kind: string, text: string) =>
    kind.toUpperCase() === 'B' ? Buffer.from(text, 'base64').toString('utf8') : decodeQuotedPrintable(text.replace(/_/g, ' ')),
  );
}

function parseMessage(from: string, to: string[], raw: string): SunkMessage {
  const split = raw.indexOf('\r\n\r\n');
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 4) : '';
  const headers: Record<string, string> = {};
  let last = '';
  for (const line of head.split('\r\n')) {
    if (/^\s/.test(line) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    headers[last] = line.slice(colon + 1).trim();
  }
  for (const key of Object.keys(headers)) headers[key] = decodeHeader(headers[key]);
  const encoding = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase();
  const text =
    encoding === 'quoted-printable'
      ? decodeQuotedPrintable(body)
      : encoding === 'base64'
        ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
        : body;
  return { from, to, headers, text: text.replace(/\r\n/g, '\n') };
}
