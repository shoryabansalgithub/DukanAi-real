import { randomUUID } from 'crypto';

/** UUIDs or plain identifiers up to 100 characters; anything else is replaced, never echoed. */
export const SAFE_IDENTIFIER = /^[a-zA-Z0-9\-_]{1,100}$/;

export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The one place a client-supplied identifier is accepted: a value that does
 * not match `SAFE_IDENTIFIER` (missing, too long, or carrying characters that
 * could break log lines or headers) is replaced by a fresh UUID. Every
 * consumer (middleware, tenant interceptor, exception filter, socket adapter)
 * uses the sanitised value rather than reading the raw header again.
 */
export function sanitizeIdentifier(value: unknown): string {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && SAFE_IDENTIFIER.test(text) ? text : randomUUID();
}
