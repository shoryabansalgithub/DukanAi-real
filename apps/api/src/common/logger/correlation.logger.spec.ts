import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { CorrelationLogger, redact } from './correlation.logger';

describe('CorrelationLogger', () => {
  const captured: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const capture = ((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  beforeEach(() => {
    captured.length = 0;
    process.stdout.write = capture;
    process.stderr.write = capture;
  });

  afterEach(() => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  });

  it('prints one JSON line per entry carrying the correlation id of the request', () => {
    const logger = new CorrelationLogger('Spec');
    const service = new TenantContextService();
    service.runWithContext({ correlationId: 'corr-123', requestId: 'req-1', shopId: 's1' }, () => {
      logger.log({ event: 'sale', password: 'hunter2' });
    });

    expect(captured).toHaveLength(1);
    const line = captured[0];
    expect(line.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line) as { message: Record<string, unknown>; context: string; level: string };
    expect(parsed.level).toBe('log');
    expect(parsed.context).toBe('Spec');
    expect(parsed.message).toEqual({ event: 'sale', password: '[REDACTED]', correlationId: 'corr-123' });
  });

  it('keeps an explicit correlation id on an object logged outside a request context', () => {
    new CorrelationLogger('HttpAccess').log({ event: 'http', status: 401, correlationId: 'corr-from-request' });
    const parsed = JSON.parse(captured[0]) as { message: Record<string, unknown> };
    expect(parsed.message).toEqual({ event: 'http', status: 401, correlationId: 'corr-from-request' });
  });

  it('keeps the explicit correlation id of an error logged with its stack outside the request (the exception filter)', () => {
    // As Nest's Logger wrapper calls it: message, stack, context.
    new CorrelationLogger().error({ message: 'Prisma error P2022', correlationId: 'corr-500' }, 'Invalid `prisma.notification.findMany()` invocation', 'GlobalExceptionFilter');
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]) as { message: Record<string, unknown>; stack?: string; context?: string };
    // Loki's json parser flattens this to message_correlationId, which the runbooks query.
    expect(parsed.message).toEqual({ message: 'Prisma error P2022', correlationId: 'corr-500' });
    expect(parsed.stack).toContain('prisma.notification.findMany');
    expect(parsed.context).toBe('GlobalExceptionFilter');
  });

  it('tags entries outside a request as system-job and wraps plain strings', () => {
    new CorrelationLogger('Spec').warn('disk almost full');
    const parsed = JSON.parse(captured[0]) as { message: Record<string, unknown> };
    expect(parsed.message).toEqual({ message: 'disk almost full', correlationId: 'system-job' });
  });

  it('logs an Error as name, message and stack, in one line on stderr', () => {
    new CorrelationLogger('Spec').error(new RangeError('boom'));
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]) as { message: Record<string, unknown> };
    expect(parsed.message).toMatchObject({ error: 'RangeError', message: 'boom', correlationId: 'system-job' });
    expect(String(parsed.message.stack)).toContain('RangeError: boom');
  });
});

describe('redact', () => {
  it('replaces sensitive keys at any depth without mutating the input', () => {
    const input = { user: { email: 'a@b.c', refresh_token: 'x' }, headers: { Authorization: 'Bearer y' }, items: [{ cookie: 'z', ok: 1 }] };
    const out = redact(input) as Record<string, unknown>;
    expect(out).toEqual({ user: { email: 'a@b.c', refresh_token: '[REDACTED]' }, headers: { Authorization: '[REDACTED]' }, items: [{ cookie: '[REDACTED]', ok: 1 }] });
    expect(input.user.refresh_token).toBe('x');
  });

  it('survives cycles and very deep graphs', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toEqual({ name: 'root', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });

  it('writes Dates and Errors as plain values', () => {
    const at = new Date('2026-09-28T00:00:00Z');
    expect(redact({ at, err: new Error('x') })).toEqual({ at: '2026-09-28T00:00:00.000Z', err: { name: 'Error', message: 'x', stack: expect.any(String) } });
  });
});
