import type { Prisma, PrismaClient } from '@prisma/client';

/** The client the script and the tests hand in; `PrismaService` extends it. */
type SessionDb = Prisma.TransactionClient;

export interface RevocationScope {
  /** Only this user; every user when absent. */
  userId?: string;
}

export interface RevocationResult {
  usersBumped: number;
  refreshTokensRevoked: number;
}

/**
 * Ends every session in scope (roadmap 9.11, incident response): every live
 * refresh token is revoked and `tokenVersion` is bumped, so no access token
 * minted before this moment is accepted (`JwtStrategy`) and no refresh can
 * mint a new one. Both writes commit together. Rotating `JWT_SECRET` alone
 * only invalidates the access tokens: the opaque refresh tokens would keep
 * minting new ones under the new secret, which is why the rotation
 * procedure (`docs/SECRETS.md`) runs this after the restart.
 *
 * Open sockets are not touched here (the script has no gateway); the API
 * restart that a secret rotation needs drops them, and the socket adapter
 * refuses the stale token on reconnect.
 */
export async function revokeAllSessions(db: PrismaClient, scope: RevocationScope = {}): Promise<RevocationResult> {
  const userWhere = scope.userId ? { id: scope.userId } : {};
  const tokenWhere = { isRevoked: false, ...(scope.userId ? { userId: scope.userId } : {}) };
  return db.$transaction(async (tx: SessionDb) => {
    const tokens = await tx.refreshToken.updateMany({ where: tokenWhere, data: { isRevoked: true } });
    const users = await tx.user.updateMany({ where: userWhere, data: { tokenVersion: { increment: 1 } } });
    return { usersBumped: users.count, refreshTokensRevoked: tokens.count };
  });
}

/** What a dry run reports: the rows the revocation would touch. */
export async function countSessions(db: SessionDb, scope: RevocationScope = {}): Promise<RevocationResult> {
  const [users, tokens] = await Promise.all([
    db.user.count({ where: scope.userId ? { id: scope.userId } : {} }),
    db.refreshToken.count({ where: { isRevoked: false, ...(scope.userId ? { userId: scope.userId } : {}) } }),
  ]);
  return { usersBumped: users, refreshTokensRevoked: tokens };
}
