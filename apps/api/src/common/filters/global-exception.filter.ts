import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { ErrorContext, ErrorTracking } from '../observability/error-tracking';
import { routeLabel } from '../observability/metrics';

interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error: string;
  code?: string;
  details?: unknown;
  correlationId: string;
  timestamp: string;
}

/**
 * Global exception filter that catches ALL unhandled errors and formats
 * them into a consistent JSON envelope with an optional machine-readable
 * `code` and `details`. Clients branch on `code`, never on `message`.
 *
 * Domain errors that are not HttpExceptions (shared math engine errors,
 * inventory engine errors) are mapped here so a service that forgets to
 * translate them still produces a deterministic, non-500 response.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    // The middleware settles req.correlationId before guards run, so a 401/403
    // thrown by a guard (before the tenant interceptor opened its context) still
    // carries the id the client can quote; the ALS store is the fallback.
    const request = ctx.getRequest<ExpressRequestLike | undefined>();
    const store = TenantContextService.asAsyncLocalStorage.getStore();
    const correlationId = request?.correlationId || store?.correlationId || 'unknown';

    let statusCode: number;
    let message: string;
    let error: string;
    let code: string | undefined;
    let details: unknown;
    // Server-side failures go to error tracking (roadmap 7.6): a 500 thrown
    // on purpose, an unmapped Prisma error, or anything that is not an
    // HttpException. Expected 5xx answers (503 draining / not configured,
    // 502 upstream) are operational and show up in the 5xx-rate metric instead.
    let trackAs: ErrorContext['kind'] | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      if (statusCode === HttpStatus.INTERNAL_SERVER_ERROR) trackAs = 'unhandled';
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        message = Array.isArray(resp.message)
          ? resp.message.join('; ')
          : typeof resp.message === 'string'
            ? resp.message
            : exception.message;
        if (typeof resp.code === 'string') code = resp.code;
        if (resp.details !== undefined) details = resp.details;
        // Legacy shape: extra keys next to message/code become details.
        if (details === undefined) {
          const extra = Object.fromEntries(
            Object.entries(resp).filter(([k]) => !['message', 'code', 'error', 'statusCode'].includes(k)),
          );
          if (Object.keys(extra).length > 0) details = extra;
        }
      } else {
        message = exception.message;
      }

      error = HttpStatus[statusCode] || exception.name || 'UnknownError';
    } else if (isNamedError(exception, 'InvoiceMathError')) {
      statusCode = HttpStatus.BAD_REQUEST;
      message = exception.message;
      error = 'BadRequest';
      code = (exception as { code?: string }).code;
    } else if (isNamedError(exception, 'InventoryError') || hasInventoryCode(exception)) {
      const invCode = (exception as { code: string }).code;
      statusCode = INVENTORY_STATUS[invCode] ?? HttpStatus.CONFLICT;
      message = (exception as Error).message;
      error = HttpStatus[statusCode] || 'Conflict';
      code = invCode;
      details = (exception as { details?: unknown }).details;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Known Prisma errors: expose a safe, deterministic code without internals.
      const mapped = PRISMA_STATUS[exception.code];
      statusCode = mapped?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
      message = mapped?.message ?? 'Internal server error';
      error = HttpStatus[statusCode] || 'InternalServerError';
      code = mapped ? `DB_${exception.code}` : undefined;
      if (!mapped) trackAs = 'prisma';
      if (exception.code === 'P2002') {
        // The unique index that rejected the write, so clients can point at the field (roadmap 3.10).
        const target = (exception.meta as { target?: unknown } | undefined)?.target;
        details = { target: Array.isArray(target) ? target.map(String) : target === undefined ? undefined : String(target) };
      }
      this.logger.error(
        `Prisma error ${exception.code} [correlationId=${correlationId}]`,
        exception.message,
      );
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      error = 'InternalServerError';
      trackAs = 'unhandled';
      this.logger.error(
        `Unhandled exception [correlationId=${correlationId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (trackAs) {
      ErrorTracking.capture(exception, {
        kind: trackAs,
        correlationId: String(correlationId),
        shopId: store?.shopId,
        userId: store?.userId,
        route: routeLabel(request?.baseUrl, request?.route?.path),
        method: request?.method,
        statusCode,
      });
    }

    const body: ErrorResponseBody = {
      statusCode,
      message,
      error,
      ...(code ? { code } : {}),
      ...(details !== undefined ? { details } : {}),
      correlationId: String(correlationId),
      timestamp: new Date().toISOString(),
    };

    response.status(statusCode).json(body);
  }
}

/** The parts of the Express request the filter reads; `route` is set once the router matched. */
interface ExpressRequestLike {
  correlationId?: string;
  method?: string;
  baseUrl?: string;
  route?: { path?: string | string[] };
}

const INVENTORY_STATUS: Record<string, number> = {
  INSUFFICIENT_STOCK: HttpStatus.CONFLICT,
  OPTIMISTIC_LOCK_CONFLICT: HttpStatus.CONFLICT,
  IDEMPOTENT_CONFLICT: HttpStatus.CONFLICT,
  NEGATIVE_STOCK_BLOCKED: HttpStatus.CONFLICT,
  INVENTORY_NOT_FOUND: HttpStatus.NOT_FOUND,
  TENANT_VIOLATION: HttpStatus.FORBIDDEN,
  LOCATION_REQUIRED: HttpStatus.BAD_REQUEST,
};

const PRISMA_STATUS: Record<string, { status: number; message: string }> = {
  P2002: { status: HttpStatus.CONFLICT, message: 'A record with the same unique value already exists.' },
  P2003: { status: HttpStatus.CONFLICT, message: 'The request references a record that does not exist.' },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'The requested record was not found.' },
  P2034: { status: HttpStatus.CONFLICT, message: 'The request conflicted with a concurrent transaction. Please retry.' },
};

function isNamedError(exception: unknown, name: string): exception is Error {
  if (!(exception instanceof Error)) return false;
  let proto: unknown = exception;
  // Walk the prototype chain by name so cross-package class identity is not required.
  while (proto && proto !== Object.prototype) {
    if ((proto as Error).name === name || (proto as { constructor?: { name?: string } }).constructor?.name === name) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

function hasInventoryCode(exception: unknown): boolean {
  return (
    exception instanceof Error &&
    typeof (exception as { code?: unknown }).code === 'string' &&
    (exception as unknown as { code: string }).code in INVENTORY_STATUS
  );
}
