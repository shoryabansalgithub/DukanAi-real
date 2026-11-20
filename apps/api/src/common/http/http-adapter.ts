import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';

/**
 * The Express instance the API serves through (audit R13). Routing is case
 * sensitive: Express matches paths case-insensitively by default, so
 * `/API/metrics` reached the metrics route past an edge or ingress rule that
 * blocks `/api/metrics` (proxies compare paths byte for byte). The setting
 * has to be made before anything registers middleware: Express builds its
 * router on the first `use`, and Nest's adapter calls `use` in its
 * constructor, so it cannot be switched on after `NestFactory.create`.
 * Strict routing (a trailing slash as a different path) stays off: clients
 * and proxies that add one keep working.
 */
export function createHttpAdapter(): ExpressAdapter {
  const instance = express();
  instance.set('case sensitive routing', true);
  return new ExpressAdapter(instance);
}
