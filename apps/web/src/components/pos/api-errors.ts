import axios from 'axios';
import { describeApiError } from '@/lib/api-error';

/**
 * Normalised view of an API failure. `code` is the stable machine string from
 * the global error envelope (`{ statusCode, message, error, code?, details? }`);
 * UIs branch on it, never on `message`.
 */
export interface ApiErrorInfo {
  status: number | null;
  code: string | null;
  /** Server message when present, otherwise the `describeApiError` fallback. */
  message: string;
  details: Record<string, unknown> | null;
  /** No HTTP response at all (network down, timeout, aborted). Safe to retry with the same key. */
  isNetwork: boolean;
  isTimeout: boolean;
  isCanceled: boolean;
}

export function extractApiError(error: unknown, operation: string): ApiErrorInfo {
  if (axios.isAxiosError(error)) {
    const isCanceled = axios.isCancel(error) || error.code === 'ERR_CANCELED';
    const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    if (!error.response) {
      return {
        status: null,
        code: null,
        message: isTimeout
          ? `${operation} timed out. The request may still have reached the server; retrying is safe.`
          : describeApiError(error, operation),
        details: null,
        isNetwork: true,
        isTimeout,
        isCanceled,
      };
    }
    const data = (error.response.data ?? {}) as {
      message?: string | string[];
      code?: string;
      details?: Record<string, unknown>;
    };
    const serverMessage = Array.isArray(data.message) ? data.message.join(', ') : data.message;
    return {
      status: error.response.status,
      code: typeof data.code === 'string' ? data.code : null,
      message: serverMessage || describeApiError(error, operation),
      details: data.details && typeof data.details === 'object' ? data.details : null,
      isNetwork: false,
      isTimeout: false,
      isCanceled: false,
    };
  }
  return {
    status: null,
    code: null,
    message: describeApiError(error, operation),
    details: null,
    isNetwork: false,
    isTimeout: false,
    isCanceled: false,
  };
}

export function detailNumber(details: Record<string, unknown> | null, key: string): number | null {
  if (!details) return null;
  const value = Number(details[key]);
  return Number.isFinite(value) ? value : null;
}

export function detailString(details: Record<string, unknown> | null, key: string): string | null {
  if (!details) return null;
  const value = details[key];
  return typeof value === 'string' ? value : null;
}
