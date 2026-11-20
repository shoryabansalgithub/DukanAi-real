/**
 * `npm run shop-data -- <export|suspend|erase|erase-customer> --shop <id> ...`
 * from a checkout (roadmap 9.24): loads `.env.local` / `.env` in apps/api as
 * the API does, then runs the command the API image ships as
 * `node dist/cli/shop-data` (`src/cli/shop-data.ts`), where the arguments,
 * the output and the exit codes are documented.
 */
import * as dotenv from 'dotenv';
import { shopDataCommand } from '../src/cli/shop-data';
import { runAsMain } from '../src/cli/run-cli';

dotenv.config({ path: '.env.local' });
dotenv.config();
runAsMain(shopDataCommand());
