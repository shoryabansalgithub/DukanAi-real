/**
 * `npm run tenant-audit -- [--json]` from a checkout (cross-shop isolation
 * audit, 2026-10-12): loads `.env.local` / `.env` in apps/api as the API
 * does, then runs the command the API image ships as `node dist/cli/tenant-audit`
 * (`src/cli/tenant-audit.ts`), where the output and the exit codes are
 * documented.
 */
import * as dotenv from 'dotenv';
import { tenantAuditCommand } from '../src/cli/tenant-audit';
import { runAsMain } from '../src/cli/run-cli';

dotenv.config({ path: '.env.local' });
dotenv.config();
runAsMain(tenantAuditCommand());
