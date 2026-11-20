import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CORRELATION_HEADER, REQUEST_ID_HEADER, sanitizeIdentifier } from '../correlation/correlation-id';

/** A request carrying the identifiers this middleware settled on. */
export interface CorrelatedRequest extends Request {
  correlationId: string;
  requestId: string;
}

/**
 * Settles the correlation and request ids once per request: a well-formed
 * client value is kept, anything else is replaced (see `sanitizeIdentifier`).
 * Downstream code reads `req.correlationId` / `req.requestId` and never the
 * raw headers again. The correlation id is echoed in the response header so
 * the client can quote it.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const request = req as CorrelatedRequest;
    request.correlationId = sanitizeIdentifier(req.headers[CORRELATION_HEADER]);
    request.requestId = sanitizeIdentifier(req.headers[REQUEST_ID_HEADER]);
    res.setHeader(CORRELATION_HEADER, request.correlationId);
    next();
  }
}
