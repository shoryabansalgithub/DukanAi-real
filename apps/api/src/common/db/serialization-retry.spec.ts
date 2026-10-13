import { Prisma } from '@prisma/client';
import { isSerializationFailure, withSerializationRetry } from './serialization-retry';

const known = (code: string, meta?: Record<string, unknown>, message = 'x') =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });

describe('isSerializationFailure', () => {
  it('recognises engine write conflicts, transaction start failures and raw MySQL deadlocks', () => {
    expect(isSerializationFailure(known('P2034'))).toBe(true);
    expect(isSerializationFailure(known('P2028'))).toBe(true);
    expect(isSerializationFailure(known('P2010', { code: '1213', message: 'Deadlock found when trying to get lock' }))).toBe(true);
    expect(isSerializationFailure(known('P2010', { code: '1205', message: 'Lock wait timeout exceeded' }))).toBe(true);
    expect(isSerializationFailure(new Error('Raw query failed. Code: `1213`. Message: `Deadlock found when trying to get lock; try restarting transaction`'))).toBe(true);
  });

  it('does not retry business or constraint errors', () => {
    expect(isSerializationFailure(known('P2002', { target: 'Invoice_shopId_idempotencyKey_key' }))).toBe(false);
    expect(isSerializationFailure(known('P2010', { code: '1062', message: 'Duplicate entry' }))).toBe(false);
    expect(isSerializationFailure(new Error('Insufficient stock'))).toBe(false);
  });
});

describe('withSerializationRetry', () => {
  it('re-runs the whole callback until it succeeds, then gives up', async () => {
    let calls = 0;
    const result = await withSerializationRetry(
      async () => {
        calls++;
        if (calls < 3) throw known('P2034');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 0, randomDelayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    await expect(withSerializationRetry(async () => { throw known('P2034'); }, { attempts: 2, baseDelayMs: 0, randomDelayMs: 0 })).rejects.toMatchObject({ code: 'P2034' });
  });
});
