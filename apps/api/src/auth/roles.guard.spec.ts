import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ANY_AUTHENTICATED_KEY } from './any-authenticated.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  const build = (metadata: Record<string, unknown>, request: { method: string; user?: { role: Role } }) => {
    const reflector = { getAllAndOverride: jest.fn((key: string) => metadata[key]) } as unknown as Reflector;
    const context = {
      getType: () => 'http',
      getHandler: () => ({ name: 'handler' }),
      getClass: () => ({ name: 'TestController' }),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return () => new RolesGuard(reflector).canActivate(context);
  };
  const owner = { role: Role.OWNER };
  const viewer = { role: Role.VIEWER };

  it('checks membership when @Roles is declared', () => {
    expect(build({ [ROLES_KEY]: [Role.OWNER, Role.MANAGER] }, { method: 'POST', user: owner })()).toBe(true);
    expect(build({ [ROLES_KEY]: [Role.OWNER, Role.MANAGER] }, { method: 'POST', user: viewer })()).toBe(false);
    expect(build({ [ROLES_KEY]: [Role.OWNER] }, { method: 'GET', user: viewer })()).toBe(false);
  });

  it('logs a refused role check with the user, the handler and the required roles (ASVS 7.2.2)', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(build({ [ROLES_KEY]: [Role.OWNER] }, { method: 'POST', user: { ...viewer, id: 'u-1' } as never })()).toBe(false);
      expect(warn).toHaveBeenCalledWith('Access denied for user u-1 (VIEWER) to TestController.handler: requires OWNER');
      expect(build({ [ROLES_KEY]: [Role.OWNER] }, { method: 'POST' })()).toBe(false);
      expect(warn).toHaveBeenCalledWith('Access denied for an anonymous request to TestController.handler: requires OWNER');
      warn.mockClear();
      expect(build({ [ROLES_KEY]: [Role.OWNER] }, { method: 'POST', user: owner })()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a state-changing handler that declares no policy, whoever calls it', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(build({}, { method, user: owner })).toThrow(ForbiddenException);
    }
  });

  it('leaves reads without @Roles open to authenticated users', () => {
    expect(build({}, { method: 'GET', user: viewer })()).toBe(true);
    expect(build({}, { method: 'HEAD', user: viewer })()).toBe(true);
  });

  it('allows @AnyAuthenticated writes for any signed-in user and refuses anonymous ones', () => {
    expect(build({ [ANY_AUTHENTICATED_KEY]: true }, { method: 'DELETE', user: viewer })()).toBe(true);
    expect(build({ [ANY_AUTHENTICATED_KEY]: true }, { method: 'DELETE' })()).toBe(false);
  });

  it('never blocks @Public handlers', () => {
    expect(build({ [IS_PUBLIC_KEY]: true }, { method: 'POST' })()).toBe(true);
  });
});
