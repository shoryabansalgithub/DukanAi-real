/**
 * Helpers shared by the security regression specs: extra users on a fixture
 * shop and an HTTP client authenticated as one of them. Access tokens are
 * issued by the application's own AuthService, exactly as a login would, so
 * every token belongs to a live session family (JwtStrategy checks it).
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AuthService } from '../../src/auth/auth.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UsersService } from '../../src/users/users.service';
import { httpTarget, tenantRunner, TestShop } from '../integration/pos-fixtures';

export interface TestUser {
  id: string;
  email: string;
  role: Role;
}

/** Adds a user with the given role to `shop`; `password` is stored as a real bcrypt hash so the login route accepts it. */
export async function createUser(app: INestApplication, shop: TestShop, role: Role, password?: string): Promise<TestUser> {
  const prisma = app.get(PrismaService);
  const run = tenantRunner(app);
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}-${shop.suffix}@test.local`;
  const hash = password ? await bcrypt.hash(password, 4) : 'x';
  const user = await run.system(() => prisma.user.create({ data: { email, name: role, role, password: hash, shopId: shop.shopId } }));
  return { id: user.id, email, role };
}

/** Opens a session for the user exactly as a login does and returns its token pair. */
export async function issueTokens(app: INestApplication, user: Pick<TestUser, 'id'>): Promise<{ access_token: string; refresh_token: string }> {
  const safeUser = await tenantRunner(app).system(() => app.get(UsersService).findSafeById(user.id));
  if (!safeUser) throw new Error(`no such user ${user.id}`);
  return app.get(AuthService).login(safeUser, '127.0.0.1', 'jest');
}

export async function bearerToken(app: INestApplication, _shop: TestShop, user: TestUser): Promise<string> {
  return (await issueTokens(app, user)).access_token;
}

/** supertest calls pre-authenticated as `user` of `shop`. */
export async function httpAs(app: INestApplication, shop: TestShop, user: TestUser) {
  const server = httpTarget(app);
  const auth = `Bearer ${await bearerToken(app, shop, user)}`;
  return {
    get: (url: string) => request(server).get(url).set('Authorization', auth),
    post: (url: string) => request(server).post(url).set('Authorization', auth),
    patch: (url: string) => request(server).patch(url).set('Authorization', auth),
    delete: (url: string) => request(server).delete(url).set('Authorization', auth),
  };
}

export function ownerOf(shop: TestShop): TestUser {
  return { id: shop.ownerId, email: `owner-${shop.suffix}@test.local`, role: Role.OWNER };
}

export function cashierOf(shop: TestShop): TestUser {
  return { id: shop.cashierId, email: `cashier-${shop.suffix}@test.local`, role: Role.CASHIER };
}
