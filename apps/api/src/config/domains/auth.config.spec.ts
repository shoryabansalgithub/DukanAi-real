import { validateSync } from 'class-validator';
import { assertAuthBypassPermitted, AuthConfig, authBypassPermitted, parseAuthDisabled } from './auth.config';

describe('parseAuthDisabled — secure by default', () => {
  it('defaults to false when unset', () => {
    expect(parseAuthDisabled(undefined)).toBe(false);
    expect(parseAuthDisabled(null)).toBe(false);
    expect(parseAuthDisabled('')).toBe(false);
  });

  it('enables only for explicit truthy tokens', () => {
    for (const token of ['true', '1', 'yes', 'on', 'TRUE', ' On ']) {
      expect(parseAuthDisabled(token)).toBe(true);
    }
  });

  it('disables for explicit falsy tokens', () => {
    for (const token of ['false', '0', 'no', 'off', 'FALSE']) {
      expect(parseAuthDisabled(token)).toBe(false);
    }
  });

  it('passes real booleans through', () => {
    expect(parseAuthDisabled(true)).toBe(true);
    expect(parseAuthDisabled(false)).toBe(false);
  });

  it('returns undefined for unrecognized values so boot is refused', () => {
    for (const token of ['maybe', 'enabled', '2', 'y', 'disable']) {
      expect(parseAuthDisabled(token)).toBeUndefined();
    }
  });
});

describe('AuthConfig validation', () => {
  function make(authDisabled: unknown): AuthConfig {
    const config = new AuthConfig();
    Object.assign(config, { authDisabled });
    return config;
  }

  it('accepts a boolean flag', () => {
    expect(validateSync(make(true))).toHaveLength(0);
    expect(validateSync(make(false))).toHaveLength(0);
  });

  it('rejects a non-boolean flag (an unrecognized env value)', () => {
    // parseAuthDisabled feeds undefined for unrecognized input; that must fail
    // @IsBoolean so the EnterpriseConfigModule refuses to boot.
    expect(validateSync(make(undefined)).length).toBeGreaterThan(0);
    expect(validateSync(make('maybe')).length).toBeGreaterThan(0);
  });
});

describe('AUTH_DISABLED is a development/test switch only', () => {
  it.each(['development', 'test'])('is permitted under NODE_ENV=%s', (env) => {
    expect(authBypassPermitted(env)).toBe(true);
    expect(() => assertAuthBypassPermitted(true, env)).not.toThrow();
  });

  it.each([['production'], [undefined], [''], ['staging']])('refuses to boot with the bypass under NODE_ENV=%j', (env) => {
    expect(authBypassPermitted(env)).toBe(false);
    expect(() => assertAuthBypassPermitted(true, env)).toThrow(/AUTH_DISABLED=true is only accepted when NODE_ENV is development or test/);
  });

  it('never complains while the bypass is off', () => {
    expect(() => assertAuthBypassPermitted(false, 'production')).not.toThrow();
    expect(() => assertAuthBypassPermitted(undefined, undefined)).not.toThrow();
  });
});
