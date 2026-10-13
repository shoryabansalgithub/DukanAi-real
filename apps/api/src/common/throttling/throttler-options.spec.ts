import { ExecutionContext } from '@nestjs/common';
import { ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { SecurityConfig } from '../../config/domains/security.config';
import { AuthThrottle, isAuthThrottled } from './auth-throttle.decorator';
import { accountTracker, AUTH_THROTTLER_NAMES, buildThrottlerOptions, GENERAL_THROTTLER_NAMES } from './throttler-options';

class SampleController {
  @AuthThrottle()
  login() {}
  list() {}
}

@AuthThrottle()
class CredentialController {
  accept() {}
}

const contextFor = (cls: new () => object, handler: () => void, body: unknown = {}): ExecutionContext =>
  ({ getHandler: () => handler, getClass: () => cls, switchToHttp: () => ({ getRequest: () => ({ body }) }) }) as unknown as ExecutionContext;

describe('buildThrottlerOptions', () => {
  const security = Object.assign(new SecurityConfig(), {
    authRateLimitShortLimit: 3,
    rateLimitShortLimit: 20,
    rateLimitShortTtlMs: 10_000,
    rateLimitMediumTtlMs: 60_000,
    authRateLimitAccountLimit: 8,
  });
  const storage = {} as ThrottlerStorage;
  const options = buildThrottlerOptions(security, storage);
  const throttlers = (options as { throttlers: ThrottlerOptions[] }).throttlers;
  const byName = (name: string) => throttlers.find((t) => t.name === name)!;

  it('hands the storage to the module and defines the seven named throttlers', () => {
    expect((options as { storage: ThrottlerStorage }).storage).toBe(storage);
    expect(throttlers.map((t) => t.name)).toEqual([...GENERAL_THROTTLER_NAMES, ...AUTH_THROTTLER_NAMES]);
  });

  it('gives the auth throttlers the AUTH_RATE_LIMIT_* limits over the same windows', () => {
    expect(byName('auth-short')).toMatchObject({ ttl: 10_000, limit: 3 });
    expect(byName('short')).toMatchObject({ ttl: 10_000, limit: 20 });
  });

  it('applies only the auth throttlers on a route marked @AuthThrottle(), only the general ones elsewhere', () => {
    const login = contextFor(SampleController, SampleController.prototype.login, { email: 'Owner@Test.local' });
    const list = contextFor(SampleController, SampleController.prototype.list, { email: 'Owner@Test.local' });
    const accept = contextFor(CredentialController, CredentialController.prototype.accept, { email: 'x@test.local' });

    for (const name of GENERAL_THROTTLER_NAMES) {
      expect(byName(name).skipIf!(login)).toBe(true);
      expect(byName(name).skipIf!(accept)).toBe(true);
      expect(byName(name).skipIf!(list)).toBe(false);
    }
    for (const name of AUTH_THROTTLER_NAMES) {
      expect(byName(name).skipIf!(login)).toBe(false);
      expect(byName(name).skipIf!(accept)).toBe(false);
      expect(byName(name).skipIf!(list)).toBe(true);
    }
    expect(isAuthThrottled(list)).toBe(false);
  });

  it('limits attempts per submitted account over the medium window, keyed case-insensitively', () => {
    const account = byName('auth-account');
    expect(account).toMatchObject({ ttl: 60_000, limit: 8 });
    expect(account.getTracker!({ body: { email: '  Owner@Test.local ' } }, {} as ExecutionContext)).toBe('account:owner@test.local');
    expect(accountTracker({ body: { email: 42 } })).toBeUndefined();
    expect(accountTracker({})).toBeUndefined();

    // A credential route whose body names no account (refresh) is not counted per account.
    const refresh = contextFor(SampleController, SampleController.prototype.login, { refresh_token: 'x' });
    expect(account.skipIf!(refresh)).toBe(true);
    expect(account.skipIf!(contextFor(SampleController, SampleController.prototype.login, { email: 'a@b.c' }))).toBe(false);
  });
});
