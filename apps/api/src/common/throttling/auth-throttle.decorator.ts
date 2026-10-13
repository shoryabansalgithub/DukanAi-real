import { ExecutionContext, SetMetadata } from '@nestjs/common';

export const AUTH_THROTTLE_KEY = 'throttle:auth';

/**
 * Marks a credential-handling route (login, register, refresh, Google
 * sign-in, invitation accept). The route is then limited by the stricter
 * `AUTH_RATE_LIMIT_*` limits from `SecurityConfig` instead of the general
 * per-IP limits; see `buildThrottlerOptions`.
 */
export const AuthThrottle = (): MethodDecorator & ClassDecorator => SetMetadata(AUTH_THROTTLE_KEY, true);

/** True when the handler or its controller carries `@AuthThrottle()`. */
export function isAuthThrottled(context: ExecutionContext): boolean {
  return (
    Reflect.getMetadata(AUTH_THROTTLE_KEY, context.getHandler()) === true ||
    Reflect.getMetadata(AUTH_THROTTLE_KEY, context.getClass()) === true
  );
}
