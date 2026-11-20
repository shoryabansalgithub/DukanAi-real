import { INestApplication, Logger } from '@nestjs/common';
import { applyTrustProxy, isTrustProxySetting, parseTrustProxy } from './trust-proxy';

describe('trust proxy setting', () => {
  it.each([
    ['false', false],
    ['FALSE', false],
    ['true', true],
    ['0', 0],
    ['2', 2],
    ['loopback', 'loopback'],
    [' loopback, 10.0.0.0/8 ', 'loopback,10.0.0.0/8'],
    ['203.0.113.7', '203.0.113.7'],
    ['fd00::/8,uniquelocal', 'fd00::/8,uniquelocal'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(isTrustProxySetting(raw)).toBe(true);
    expect(parseTrustProxy(raw)).toEqual(expected);
  });

  it.each(['', 'yes', '-1', '1.5', 'nginx', '10.0.0.0/33', '10.0.0.0/8/x', 'loopback,,', '::1/129', 'loopback;linklocal'])(
    'rejects %j',
    (raw) => {
      expect(isTrustProxySetting(raw)).toBe(false);
    },
  );

  it('rejects non-strings', () => {
    expect(isTrustProxySetting(1)).toBe(false);
    expect(isTrustProxySetting(undefined)).toBe(false);
  });

  it('applies the parsed setting to the Express instance and warns only for "true"', () => {
    const set = jest.fn();
    const app = { getHttpAdapter: () => ({ getInstance: () => ({ set }) }) } as unknown as INestApplication;
    const logger = { warn: jest.fn(), log: jest.fn() } as unknown as Logger;

    expect(applyTrustProxy(app, '1', logger)).toBe(1);
    expect(set).toHaveBeenLastCalledWith('trust proxy', 1);
    expect(logger.warn).not.toHaveBeenCalled();

    expect(applyTrustProxy(app, 'false', logger)).toBe(false);
    expect(set).toHaveBeenLastCalledWith('trust proxy', false);

    expect(applyTrustProxy(app, 'true', logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
