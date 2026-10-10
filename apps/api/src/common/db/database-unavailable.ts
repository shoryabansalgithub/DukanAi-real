import { Prisma } from '@prisma/client';

/**
 * Prisma codes that mean the database could not be reached or answered no
 * more (roadmap 9.18, MySQL stopped for 60 s): P1001 can't reach the server,
 * P1002 connection timed out, P1008 operation timed out, P1011 TLS failure
 * opening the connection, P1017 the server closed the connection, P2024 no
 * pool connection within the wait, P2028 a transaction could not start.
 */
const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1011', 'P1017', 'P2024', 'P2028']);

/**
 * MySQL client/server errors that surface as PrismaClientUnknownRequestError
 * when a statement meets a server going away: 1053 shutdown in progress,
 * 2002/2003 cannot connect, 2006 server has gone away, 2013 lost connection
 * during query, plus the engine's own wording for a closed socket.
 */
const UNAVAILABLE_TEXT = /\b(code: (1053|2002|2003|2006|2013)\b|Server shutdown in progress|Server has closed the connection|Can't reach database server|Connection refused|Timed out fetching a new connection)/i;

/**
 * True when the error says the database is unavailable rather than that the
 * request was wrong or the code is broken. Such errors are answered 503
 * DATABASE_UNAVAILABLE (retry later; the readiness probe and its alert carry
 * the outage), never 500, and are not reported to error tracking as bugs.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return UNAVAILABLE_CODES.has(error.code);
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return UNAVAILABLE_TEXT.test(error.message);
  return false;
}
