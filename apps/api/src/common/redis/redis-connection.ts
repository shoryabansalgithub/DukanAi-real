import type { RedisOptions } from 'ioredis';

/**
 * BullMQ connection options from `REDIS_URL` (roadmap 2.12, audit P2-22).
 * The URL is parsed once, properly: `rediss://` turns TLS on, the password
 * and username are percent-decoded (ioredis would use them raw), and the path
 * selects the database. `maxRetriesPerRequest: null` is what BullMQ requires
 * for its blocking connections.
 */
export function bullConnectionFromUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must start with redis:// or rediss:// (got ${parsed.protocol})`);
  }
  const db = Number.parseInt(parsed.pathname.replace(/^\//, ''), 10);
  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    // redis://host:port/<db>: queues must live in the configured database, or
    // environments sharing one Redis server consume each other's jobs.
    db: Number.isInteger(db) && db >= 0 ? db : 0,
    maxRetriesPerRequest: null,
  };
  if (parsed.protocol === 'rediss:') {
    options.tls = { servername: parsed.hostname };
  }
  return options;
}
