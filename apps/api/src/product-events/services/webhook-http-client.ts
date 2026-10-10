import { Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { LookupFunction } from 'node:net';
import { ResolvedTarget } from '../../common/net/outbound-url-guard';

export interface WebhookPostRequest {
  target: ResolvedTarget;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface WebhookPostResult {
  status: number;
}

/**
 * The one HTTP client webhooks go out through (roadmap 4.8). Redirects are
 * never followed (a 3xx is a failed delivery: following one would reach a
 * host nobody vetted), the connection is pinned to the address the guard
 * resolved, the response body is capped, and only a 2xx counts as delivered.
 * Tests replace this provider to observe deliveries without a network.
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
    const response: AxiosResponse = await axios.post(target.url.toString(), request.body, {
      headers: request.headers,
      timeout: request.timeoutMs,
      maxRedirects: 0,
      maxContentLength: request.maxResponseBytes,
      maxBodyLength: request.body.length,
      responseType: 'text',
      transformResponse: (data: unknown) => data,
      validateStatus: (status) => status >= 200 && status < 300,
      // axios declares its own LookupAddress shape; the Node signature is what the http agent calls.
      lookup: pinned as unknown as AxiosRequestConfig['lookup'],
    });
    return { status: response.status };
  }
}
