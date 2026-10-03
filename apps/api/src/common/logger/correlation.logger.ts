import { ConsoleLogger, ConsoleLoggerOptions } from '@nestjs/common';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

const SENSITIVE_KEYS = ['password', 'token', 'cookie', 'secret', 'payment', 'authorization', 'creditcard', 'refresh_token', 'access_token'];
const MAX_DEPTH = 8;

/**
 * Application logger (roadmap 2.14): one JSON line per entry, carrying the
 * correlation id of the request (or `system-job` outside one), with
 * sensitive keys redacted. Redaction copies the value, never mutates it, and
 * is safe on cycles (`[Circular]`) and deep graphs (`[Truncated]`); Errors
 * are written as name, message and stack. The JSON mode of Nest's
 * ConsoleLogger prints a single line per call, so log shippers get one record
 * per entry instead of a multi-line `Object(2)` dump.
 */
export class CorrelationLogger extends ConsoleLogger {
  constructor(context?: string, options: ConsoleLoggerOptions = {}) {
    super(context ?? '', { json: true, colors: false, ...options });
  }

  /** Attaches the correlation id and redacts; exported for tests. */
  formatMessageWithCorrelation(message: unknown): Record<string, unknown> {
    const correlationId = TenantContextService.asAsyncLocalStorage.getStore()?.correlationId || 'system-job';
    if (message instanceof Error) {
      return { message: message.message, error: message.name, stack: message.stack, correlationId };
    }
    if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
      return { ...(redact(message) as Record<string, unknown>), correlationId };
    }
    return { message: typeof message === 'string' ? message : redact(message), correlationId };
  }

  // ConsoleLogger reads the context (and, for error, the stack) from the
  // trailing optional parameters; an explicit `undefined` there is printed as
  // a second, empty entry, so only the parameters that were given are passed on.
  log(message: unknown, context?: string) {
    super.log(this.formatMessageWithCorrelation(message), ...given(context));
  }

  error(message: unknown, trace?: string, context?: string) {
    super.error(this.formatMessageWithCorrelation(message), ...given(trace, context));
  }

  warn(message: unknown, context?: string) {
    super.warn(this.formatMessageWithCorrelation(message), ...given(context));
  }

  debug(message: unknown, context?: string) {
    super.debug(this.formatMessageWithCorrelation(message), ...given(context));
  }

  verbose(message: unknown, context?: string) {
    super.verbose(this.formatMessageWithCorrelation(message), ...given(context));
  }
}

function given(...params: Array<string | undefined>): string[] {
  return params.filter((p): p is string => typeof p === 'string');
}

/** Deep copy with sensitive keys replaced, cycle- and depth-safe. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    copy[key] = SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive)) ? '[REDACTED]' : redact(entry, seen, depth + 1);
  }
  return copy;
}
