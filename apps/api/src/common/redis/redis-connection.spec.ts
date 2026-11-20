import { bullConnectionFromUrl } from './redis-connection';

describe('bullConnectionFromUrl', () => {
  it('reads host, port and database from a plain URL and disables the per-request retry cap', () => {
    expect(bullConnectionFromUrl('redis://localhost:6379/1')).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 1,
      maxRetriesPerRequest: null,
    });
  });

  it('defaults the port and database', () => {
    expect(bullConnectionFromUrl('redis://cache.internal')).toMatchObject({ host: 'cache.internal', port: 6379, db: 0 });
  });

  it('percent-decodes credentials and turns TLS on for rediss://', () => {
    const options = bullConnectionFromUrl('rediss://app%40shop:p%40ss%2Fword@redis.example.com:6380/2');
    expect(options).toMatchObject({ host: 'redis.example.com', port: 6380, username: 'app@shop', password: 'p@ss/word', db: 2 });
    expect(options.tls).toEqual({ servername: 'redis.example.com' });
  });

  it('rejects other schemes', () => {
    expect(() => bullConnectionFromUrl('http://localhost:6379')).toThrow(/redis:\/\/ or rediss:\/\//);
  });
});
