import { Injectable, Logger, OnModuleInit, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ANY_AUTHENTICATED_KEY } from './any-authenticated.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

const READ_METHODS = new Set([RequestMethod.GET, RequestMethod.HEAD, RequestMethod.OPTIONS]);

/**
 * Refuses to boot when a handler that changes state has no authorization
 * policy. Every POST/PUT/PATCH/DELETE handler must carry `@Roles(...)`,
 * `@AnyAuthenticated()` or `@Public()` on the method or its controller.
 * `RolesGuard` would refuse such a request at runtime; failing at startup
 * turns a silent 403 in production into a red CI run.
 */
@Injectable()
export class RouteAuthorizationAssertion implements OnModuleInit {
  private readonly logger = new Logger(RouteAuthorizationAssertion.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const offenders = this.findUnprotectedWriteHandlers();
    if (offenders.length) {
      throw new Error(
        `${offenders.length} write handler(s) declare no authorization policy (@Roles, @AnyAuthenticated or @Public):\n  ${offenders.join('\n  ')}`,
      );
    }
    this.logger.log('Every state-changing route declares an authorization policy.');
  }

  findUnprotectedWriteHandlers(): string[] {
    const offenders: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      const classHasPolicy = hasPolicy(metatype);
      const prefix = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined || READ_METHODS.has(method)) continue;
        if (classHasPolicy || hasPolicy(handler)) continue;
        const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        offenders.push(`${metatype.name}.${name} (${RequestMethod[method]} /${[prefix, path].filter((p) => p && p !== '/').join('/')})`);
      }
    }
    return offenders;
  }
}

function hasPolicy(target: object): boolean {
  const roles = Reflect.getMetadata(ROLES_KEY, target) as unknown[] | undefined;
  return Boolean(roles?.length) || Reflect.getMetadata(IS_PUBLIC_KEY, target) === true || Reflect.getMetadata(ANY_AUTHENTICATED_KEY, target) === true;
}
