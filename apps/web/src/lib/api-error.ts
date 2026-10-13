import axios from 'axios';

import { clientConfig } from '../config/env';

/**
 * Global API error envelope (see docs/POS_BILLING_CONTRACT.md):
 * `{ statusCode, message, error, code?, details?, correlationId, timestamp }`.
 * Clients branch on `code`, never on `message`.
 */
interface ApiErrorEnvelope {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

function readEnvelope(error: unknown): ApiErrorEnvelope | undefined {
  if (!axios.isAxiosError(error) || !error.response) return undefined;
  const data = error.response.data;
  // Blob responses (CSV downloads) cannot carry a JSON envelope.
  if (!data || typeof data !== 'object' || (typeof Blob !== 'undefined' && data instanceof Blob)) {
    return undefined;
  }
  return data as ApiErrorEnvelope;
}

/** Stable machine code from `error.response.data.code`, if the API sent one. */
export function getApiErrorCode(error: unknown): string | undefined {
  const code = readEnvelope(error)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** Structured `error.response.data.details`, if the API sent any. */
export function getApiErrorDetails(error: unknown): Record<string, unknown> | undefined {
  const details = readEnvelope(error)?.details;
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

/** HTTP status of an API error, if the request reached the server. */
export function getApiErrorStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

/**
 * Turns any thrown API error into a specific, user-facing message that names
 * the operation that failed and, when relevant, the unreachable API URL.
 * Always logs the underlying error so root causes are never swallowed.
 */
export function describeApiError(error: unknown, operation: string): string {
  console.error(`[api] ${operation} failed:`, error);

  if (axios.isAxiosError(error)) {
    if (!error.response) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return `${operation} timed out: the API at ${clientConfig.NEXT_PUBLIC_API_URL} did not answer in time.`;
      }
      return `${operation} failed: the API at ${clientConfig.NEXT_PUBLIC_API_URL} is unreachable. Is the backend running?`;
    }
    const data = readEnvelope(error);
    const serverMessage = Array.isArray(data?.message) ? data?.message.join(', ') : data?.message;
    return `${operation} failed (HTTP ${error.response.status}${serverMessage ? `: ${serverMessage}` : ''}).`;
  }

  if (error instanceof Error && error.message) {
    return `${operation} failed: ${error.message}`;
  }
  return `${operation} failed due to an unexpected error.`;
}
