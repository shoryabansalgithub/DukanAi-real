/**
 * `npm run sessions:revoke-all -- [--user <id|email>] [--yes]` from a
 * checkout (roadmap 9.11): loads `.env.local` / `.env` in apps/api as the API
 * does, then runs the command the API image ships as
 * `node dist/cli/revoke-all-sessions` (`src/cli/revoke-all-sessions.ts`,
 * roadmap 9.22), where the arguments, the output and the exit codes are
 * documented.
 */
import * as dotenv from 'dotenv';
import { revokeAllSessionsCommand } from '../src/cli/revoke-all-sessions';
import { runAsMain } from '../src/cli/run-cli';

dotenv.config({ path: '.env.local' });
dotenv.config();
runAsMain(revokeAllSessionsCommand());
