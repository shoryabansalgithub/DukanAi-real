import { INestApplication, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/** What Express accepts for `app.set('trust proxy', ...)`. */
export type TrustProxySetting = boolean | number | string;

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const HOP_COUNT = /^\d+$/;

function isAddressOrRange(token: string): boolean {
  const [address, prefix, ...rest] = token.split('/');
  if (rest.length > 0 || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  if (!HOP_COUNT.test(prefix)) return false;
  return Number(prefix) <= (isIP(address) === 4 ? 32 : 128);
}

/**
 * `TRUST_PROXY` grammar: `false` (trust nothing), `true` (trust every hop),
 * a hop count, or a comma-separated list of `loopback` / `linklocal` /
 * `uniquelocal` / IP addresses / CIDR ranges. Case-insensitive, blank-tolerant.
 */
export function isTrustProxySetting(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === 'false' || HOP_COUNT.test(text)) return true;
  const tokens = text.split(',').map((t) => t.trim());
  return tokens.length > 0 && tokens.every((t) => t !== '' && (NAMED_RANGES.has(t) || isAddressOrRange(t)));
}

/** Converts a validated `TRUST_PROXY` value into the Express setting. */
export function parseTrustProxy(value: string): TrustProxySetting {
  const text = value.trim().toLowerCase();
  if (text === 'false') return false;
  if (text === 'true') return true;
  if (HOP_COUNT.test(text)) return Number(text);
  return text
    .split(',')
    .map((t) => t.trim())
    .join(',');
}

export function IsTrustProxySetting(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isTrustProxySetting',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => isTrustProxySetting(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} must be false, true, a hop count, or a comma-separated list of loopback/linklocal/uniquelocal/IP/CIDR (got ${JSON.stringify(args.value)})`,
      },
    });
  };
}

/**
 * Applies `TRUST_PROXY` to the Express instance behind the Nest application.
 * With it, `req.ip` (the rate limiter's tracker and the address in login
 * audit rows) is the client behind the configured proxies instead of the
 * proxy itself. `false` keeps Express ignoring `X-Forwarded-For`, so a client
 * cannot pick its own address; `true` lets it, hence the warning.
 */
export function applyTrustProxy(app: INestApplication, value: string, logger: Logger = new Logger('TrustProxy')): TrustProxySetting {
  const setting = parseTrustProxy(value);
  const express = app.getHttpAdapter().getInstance() as { set: (name: string, value: TrustProxySetting) => void };
  express.set('trust proxy', setting);
  if (setting === true) {
    logger.warn('TRUST_PROXY=true trusts every hop: any client can choose the address rate limits and audit rows see. Set the proxy hop count instead.');
  } else if (setting !== false) {
    logger.log(`Trusting reverse proxies: ${String(setting)}`);
  }
  return setting;
}
