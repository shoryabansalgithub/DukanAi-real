/**
 * `npm run reconcile -- --shop <shopId> [--date YYYY-MM-DD] [--json]`, or
 * `--all-shops`, from a checkout (roadmap 9.5): loads `.env.local` / `.env`
 * in apps/api as the API does, then runs the command the API image ships as
 * `node dist/cli/reconcile` (`src/cli/reconcile.ts`, roadmap 9.22), where
 * the arguments, the output and the exit codes are documented.
 */
import * as dotenv from 'dotenv';
import { reconcileCommand } from '../src/cli/reconcile';
import { runAsMain } from '../src/cli/run-cli';

dotenv.config({ path: '.env.local' });
dotenv.config();
runAsMain(reconcileCommand());
