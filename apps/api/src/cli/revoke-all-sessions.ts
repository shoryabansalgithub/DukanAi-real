/**
 * Ends every session, or one user's (roadmap 9.11: the step after a
 * JWT_SECRET rotation, and the incident-response lever), an operator command
 * that ships in the API image (roadmap 9.22, `run-cli.ts`):
 *
 *     node dist/cli/revoke-all-sessions --yes                    # in the API container: everyone
 *     node dist/cli/revoke-all-sessions --user <id|email> --yes
 *     node dist/cli/revoke-all-sessions                          # dry run: counts only
 *     npm run sessions:revoke-all -- <the same arguments>         # from a checkout
 *
 * Revokes every live refresh token and bumps `tokenVersion`
 * (`src/auth/session-revocation.ts`), in one transaction: every access token
 * minted before now is refused and no refresh can mint a new one, so every
 * browser and socket signs in again. Nothing else changes: passwords, shops
 * and data are untouched. Exit 0 on success, 2 on a usage or connection
 * error. `DATABASE_URL` comes from the environment: the container's own, or
 * the checkout's `.env.local` / `.env` through `scripts/revoke-all-sessions.ts`.
 */
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { countSessions, revokeAllSessions } from '../auth/session-revocation';
import { CliCommand, CliUsageError, runAsMain } from './run-cli';

export const REVOKE_USAGE = 'usage: revoke-all-sessions [--user <id|email>] [--yes]   (without --yes: a dry run)';

export interface RevokeDeps {
  /** A client on `DATABASE_URL`, disconnected when the command ends. */
  connect: () => PrismaClient;
  out: (line: string) => void;
}

const DEFAULT_DEPS: RevokeDeps = {
  connect: () => {
    if (!process.env.DATABASE_URL) throw new CliUsageError('DATABASE_URL is not set');
    return new PrismaClient();
  },
  out: (line) => console.log(line),
};

export function revokeAllSessionsCommand(overrides: Partial<RevokeDeps> = {}): CliCommand {
  const deps: RevokeDeps = { ...DEFAULT_DEPS, ...overrides };
  return async (argv) => {
    const { values } = parseArgs({
      args: argv,
      options: {
        user: { type: 'string' },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
    if (values.help) {
      deps.out(REVOKE_USAGE);
      return 0;
    }
    const db = deps.connect();
    try {
      let userId: string | undefined;
      if (values.user) {
        const user = values.user;
        const row = await db.user.findFirst({ where: user.includes('@') ? { email: user } : { id: user }, select: { id: true, email: true } });
        if (!row) throw new CliUsageError(`no user matches "${user}"`);
        userId = row.id;
        deps.out(`Scope: user ${row.email} (${row.id})`);
      } else {
        deps.out('Scope: every user');
      }
      const before = await countSessions(db, { userId });
      deps.out(`Live refresh tokens: ${before.refreshTokensRevoked}; users whose tokenVersion will advance: ${before.usersBumped}`);
      if (values.yes !== true) {
        deps.out('Dry run: nothing changed. Pass --yes to end these sessions.');
        return 0;
      }
      const result = await revokeAllSessions(db, { userId });
      deps.out(
        `Done: ${result.refreshTokensRevoked} refresh token(s) revoked, tokenVersion advanced for ${result.usersBumped} user(s). Every access token minted before now is refused; restart the API if JWT_SECRET changed so open sockets drop too.`,
      );
      return 0;
    } finally {
      await db.$disconnect();
    }
  };
}

if (require.main === module) runAsMain(revokeAllSessionsCommand());
