import { Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { LookupFunction } from 'node:net';
import { ResolvedTarget } from '../../common/net/outbound-url-guard';

export interface WebhookPostRequest {
  target: ResolvedTarget;
  body: string;
  headers: Record<string, string>;
  /** The whole exchange (connect, send, headers, body) must finish within this. */
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface WebhookPostResult {
  status: number;
}

/** The delivery ran past its total deadline (a slow or dripping receiver). */
export class WebhookDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`webhook exchange did not finish within ${timeoutMs} ms`);
    this.name = 'WebhookDeadlineError';
  }
}

/**
 * The one HTTP client webhooks go out through (roadmap 4.8). Redirects are
 * never followed (a 3xx is a failed delivery: following one would reach a
 * host nobody vetted), the connection is pinned to the address the guard
 * resolved, the response body is capped, and only a 2xx counts as delivered.
 * Tests replace this provider to observe deliveries without a network.
 *
 * Audit R2 / R6 / R12: the body goes out as UTF-8 bytes and the request size
 * limit is that byte length (the string's length counts UTF-16 units, so any
 * Hindi product name or "₹" made axios refuse every delivery); no proxy from
 * the environment is ever used (`HTTPS_PROXY` would carry the pinned,
 * vetted connection somewhere else); and the exchange has a total deadline
 * (`AbortSignal.timeout`): axios' own `timeout` is an idle timer, which a
 * receiver dripping one byte at a time never trips, holding the single
 * delivery worker for as long as it likes.
 */
@Injectable()
export class WebhookHttpClient {
  async post(request: WebhookPostRequest): Promise<WebhookPostResult> {
    const { target } = request;
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options !== null && 'all' in options && options.all) {
        (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: target.address, family: target.family }]);
        return;
      }
      callback(null, target.address, target.family);
    };
    const body = Buffer.from(request.body, 'utf8');
    const deadline = AbortSignal.timeout(request.timeoutMs);
    try {
      const response: AxiosResponse = await axios.post(target.url.toString(), body, {
        headers: request.headers,
        timeout: request.timeoutMs,
        signal: deadline,
        proxy: false,
        maxRedirects: 0,
        maxContentLength: request.maxResponseBytes,
        maxBodyLength: body.length,
        responseType: 'text',
        transformResponse: (data: unknown) => data,
        validateStatus: (status) => status >= 200 && status < 300,
        // axios declares its own LookupAddress shape; the Node signature is what the http agent calls.
        lookup: pinned as unknown as AxiosRequestConfig['lookup'],
      });
      return { status: response.status };
    } catch (error) {
      if (deadline.aborted) throw new WebhookDeadlineError(request.timeoutMs);
      throw error;
    }
  }
}
