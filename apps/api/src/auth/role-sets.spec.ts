import { Role } from '@prisma/client';
import { ADMIN_ROLES, MANAGEMENT_ROLES, outranks, POS_ROLES, ROLE_RANK } from './role-sets';

describe('role sets', () => {
  it('ranks every role exactly once, highest first', () => {
    const ranks = Object.values(Role).map((r) => ROLE_RANK[r]);
    expect(new Set(ranks).size).toBe(Object.values(Role).length);
    expect(ROLE_RANK[Role.SUPER_ADMIN]).toBeGreaterThan(ROLE_RANK[Role.OWNER]);
    expect(ROLE_RANK[Role.OWNER]).toBeGreaterThan(ROLE_RANK[Role.ADMIN]);
    expect(ROLE_RANK[Role.ADMIN]).toBeGreaterThan(ROLE_RANK[Role.MANAGER]);
    expect(ROLE_RANK[Role.MANAGER]).toBeGreaterThan(ROLE_RANK[Role.CASHIER]);
    expect(ROLE_RANK[Role.CASHIER]).toBeGreaterThan(ROLE_RANK[Role.VIEWER]);
  });

  it('outranks is strict', () => {
    expect(outranks(Role.MANAGER, Role.CASHIER)).toBe(true);
    expect(outranks(Role.MANAGER, Role.MANAGER)).toBe(false);
    expect(outranks(Role.MANAGER, Role.ADMIN)).toBe(false);
  });

  it('the role sets nest', () => {
    expect(MANAGEMENT_ROLES).toEqual(expect.arrayContaining([...ADMIN_ROLES]));
    expect(POS_ROLES).toEqual(expect.arrayContaining([...MANAGEMENT_ROLES]));
  });
});
