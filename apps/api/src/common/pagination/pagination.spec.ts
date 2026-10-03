import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { firstValueFrom, of } from 'rxjs';
import { clampSkip, clampTake, DEFAULT_LIST_TAKE, limitOffsetArgs, LimitOffsetQueryDto, ListQueryDto, MAX_LIST_TAKE, pageArgs } from './list-query.dto';
import { isPagedResult, PAGE_HEADERS, PagedListInterceptor } from './paged-list.interceptor';

describe('list pagination (roadmap 5.6)', () => {
  describe('ListQueryDto', () => {
    const check = async (query: Record<string, string>) => validate(plainToInstance(ListQueryDto, query));

    it('accepts an absent page and coerces query strings to integers', async () => {
      expect(await check({})).toHaveLength(0);
      const dto = plainToInstance(ListQueryDto, { skip: '20', take: '10' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto).toEqual({ skip: 20, take: 10 });
    });

    it('refuses a page size above the hard cap, a zero page, a negative skip and garbage', async () => {
      expect(await check({ take: String(MAX_LIST_TAKE + 1) })).not.toHaveLength(0);
      expect(await check({ take: '0' })).not.toHaveLength(0);
      expect(await check({ skip: '-1' })).not.toHaveLength(0);
      expect(await check({ take: 'all' })).not.toHaveLength(0);
      expect(await check({ take: '1.5' })).not.toHaveLength(0);
      expect(await check({ take: String(MAX_LIST_TAKE) })).toHaveLength(0);
    });

    it('LimitOffsetQueryDto carries the same cap under the legacy names', async () => {
      expect(await validate(plainToInstance(LimitOffsetQueryDto, { limit: '5000' }))).not.toHaveLength(0);
      expect(await validate(plainToInstance(LimitOffsetQueryDto, { limit: '50', offset: '100' }))).toHaveLength(0);
    });
  });

  describe('pageArgs', () => {
    it('defaults to the first page of DEFAULT_LIST_TAKE rows', () => {
      expect(pageArgs(undefined)).toEqual({ skip: 0, take: DEFAULT_LIST_TAKE });
      expect(pageArgs({})).toEqual({ skip: 0, take: DEFAULT_LIST_TAKE });
      expect(pageArgs({}, 25)).toEqual({ skip: 0, take: 25 });
    });

    it('never exceeds MAX_LIST_TAKE even for a direct caller that skipped validation', () => {
      expect(pageArgs({ skip: 30, take: 10_000 })).toEqual({ skip: 30, take: MAX_LIST_TAKE });
      expect(clampTake(Number.NaN)).toBe(DEFAULT_LIST_TAKE);
      expect(clampTake(0)).toBe(1);
      expect(clampTake(-5)).toBe(1);
      expect(clampSkip(-3)).toBe(0);
      expect(clampSkip(Number.POSITIVE_INFINITY)).toBe(0);
      expect(limitOffsetArgs({ limit: 999_999, offset: 7 })).toEqual({ limit: MAX_LIST_TAKE, offset: 7 });
      expect(limitOffsetArgs(undefined)).toEqual({ limit: 50, offset: 0 });
    });
  });

  describe('PagedListInterceptor', () => {
    const run = async (result: unknown) => {
      const headers: Record<string, string> = {};
      const context = { switchToHttp: () => ({ getResponse: () => ({ setHeader: (k: string, v: string) => (headers[k] = v) }) }) };
      const body = await firstValueFrom(new PagedListInterceptor().intercept(context as never, { handle: () => of(result) } as never) as never);
      return { body, headers };
    };

    it('answers the items as the body and the page in headers', async () => {
      const { body, headers } = await run({ items: [{ id: 'a' }, { id: 'b' }], total: 57, skip: 10, take: 2 });
      expect(body).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(headers).toEqual({ [PAGE_HEADERS.total]: '57', [PAGE_HEADERS.skip]: '10', [PAGE_HEADERS.take]: '2' });
    });

    it('leaves any other result untouched', async () => {
      expect((await run({ items: [], total: 'n/a' })).body).toEqual({ items: [], total: 'n/a' });
      expect((await run([1, 2])).body).toEqual([1, 2]);
      expect(isPagedResult({ items: [], total: 0, skip: 0, take: 1 })).toBe(true);
      expect(isPagedResult(null)).toBe(false);
    });
  });
});
