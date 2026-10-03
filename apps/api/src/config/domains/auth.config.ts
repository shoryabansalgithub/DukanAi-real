import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IsBoolean } from 'class-validator';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off', '']);

/**
 * Parse the operator-controlled AUTH_DISABLED flag.
 *
 * Secure by default: an unset value resolves to `false` (auth enabled). Only an
 * explicit truthy token (`true`/`1`/`yes`/`on`) enables the bypass; recognized
 * falsy tokens resolve to `false`. Anything else returns `undefined` so the
 * @IsBoolean validation fails and the app REFUSES to boot rather than guessing.
 */
export function parseAuthDisabled(
  raw: string | boolean | undefined | null,
): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined;
}

/** Environments in which `AUTH_DISABLED=true` is accepted at all. */
const BYPASS_ENVIRONMENTS = new Set(['development', 'test']);

/**
 * The bypass is a local-demo and test-harness switch. Production, and a
 * process that never said which environment it is, must not honour it: the
 * config factory refuses to boot and `AuthBypassService.isEnabled` stays
 * false either way.
 */
export function authBypassPermitted(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && BYPASS_ENVIRONMENTS.has(nodeEnv);
}

/** Boot-time check for the AuthConfig factory: throws when the bypass is requested where it is not permitted. */
export function assertAuthBypassPermitted(authDisabled: boolean | undefined, nodeEnv: string | undefined): void {
  if (authDisabled === true && !authBypassPermitted(nodeEnv)) {
    throw new Error(
      `AUTH_DISABLED=true is only accepted when NODE_ENV is development or test (NODE_ENV=${JSON.stringify(nodeEnv)}). Remove the flag or set it in an untracked .env.local of a development machine.`,
    );
  }
}

/**
 * Authentication configuration domain.
 *
 * Owns the reversible AUTH_DISABLED switch consumed by AuthBypassService and
 * JwtAuthGuard. The flag never accepts identity from a request; it only gates
 * whether real JWT validation runs, so it cannot reintroduce an auth-bypass
 * hole. Validated declaratively by the EnterpriseConfigModule at startup.
 */
@Injectable()
@ConfigDomain({ owner: 'Auth', feature: 'Configuration', version: '1.0.0', description: 'AuthConfig Domain' })
export class AuthConfig {
  @IsBoolean()
  @EnvVariable('AUTH_DISABLED')
  readonly authDisabled: boolean = false;
}
