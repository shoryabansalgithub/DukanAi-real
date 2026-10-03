import { applyDecorators, CallHandler, ExecutionContext, Injectable, NestInterceptor, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs';

/** What a paged service method returns (roadmap 5.6). */
export interface PagedResult<T> {
  items: T[];
  total: number;
  skip: number;
  take: number;
}

export function isPagedResult(value: unknown): value is PagedResult<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PagedResult<unknown>>;
  return Array.isArray(candidate.items) && typeof candidate.total === 'number' && typeof candidate.skip === 'number' && typeof candidate.take === 'number';
}

export const PAGE_HEADERS = {
  total: 'X-Total-Count',
  skip: 'X-Page-Skip',
  take: 'X-Page-Take',
} as const;

/**
 * Answers a `PagedResult` as its plain `items` array with the page described
 * in response headers. The web pages that consume these lists render an
 * array and were unchanged by the cap; the headers let a client page.
 * A handler that returns anything else passes through untouched.
 */
@Injectable()
export class PagedListInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): ReturnType<CallHandler['handle']> {
    const response = context.switchToHttp().getResponse<Response>();
    const unwrap = map((result: unknown) => {
      if (!isPagedResult(result)) return result;
      response.setHeader(PAGE_HEADERS.total, String(result.total));
      response.setHeader(PAGE_HEADERS.skip, String(result.skip));
      response.setHeader(PAGE_HEADERS.take, String(result.take));
      return result.items;
    });
    // The workspace holds two rxjs copies (@nestjs/* on the hoisted 7.8.2, apps/api on its own 7.8.1);
    // they are the same code but distinct types, so the operator is applied through `unknown`.
    return next.handle().pipe(unwrap as unknown as Parameters<ReturnType<CallHandler['handle']>['pipe']>[0]);
  }
}

/** Marks a list handler whose service returns a `PagedResult`: the body is the array, the page is in headers. */
export function PagedList(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseInterceptors(PagedListInterceptor));
}
