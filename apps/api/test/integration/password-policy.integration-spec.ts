import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { bootApp, httpTarget } from './pos-fixtures';

/**
 * Roadmap 9.15 (ASVS V2.1 / 2.1.5 / 2.2.3 / 7.2.1): the one password policy
 * on every route that sets a password, and the change-password route of the
 * signed-in account. Public routes only, so the suite also runs against the
 * release candidate image under CERTIFY_API_URL.
 */
describe('password policy and change-password (roadmap 9.15)', () => {
  let app: INestApplication;
  const api = () => request(httpTarget(app));
  const stamp = () => randomBytes(4).toString('hex');

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const register = (password: string) => {
    const s = stamp();
    return api().post('/api/auth/register').send({ email: `policy-${s}@test.local`, password, name: 'Policy', shopName: `Policy shop ${s}` });
  };

  it('registration refuses fewer than 12 characters and a common password, with the reason and never the value', async () => {
    const short = await register('Short-Pw-1');
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body)).toMatch(/at least 12 characters/);

    const common = await register('Password@1234');
    expect(common.status).toBe(400);
    expect(JSON.stringify(common.body)).toMatch(/too common/);
    expect(JSON.stringify(common.body)).not.toContain('Password@1234');

    expect((await register('green tea at four pm')).status).toBe(201);
  });

  it('the reset route applies the same policy before it touches the token', async () => {
    const res = await api().post('/api/auth/reset-password').send({ token: 'a'.repeat(64), password: 'qwertyuiop123' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/too common/);
  });

  describe('POST /auth/change-password', () => {
    const s = stamp();
    const email = `change-${s}@test.local`;
    const original = `Original-${s}-Passw0rd`;
    const replacement = `Replacement-${s}-Phrase`;
    let token: string;

    beforeAll(async () => {
      expect((await api().post('/api/auth/register').send({ email, password: original, name: 'Changer', shopName: `Change shop ${s}` })).status).toBe(201);
      const login = await api().post('/api/auth/login').send({ email, password: original });
      expect(login.status).toBe(201);
      token = login.body.access_token;
    });

    it('needs a session', async () => {
      expect((await api().post('/api/auth/change-password').send({ currentPassword: original, newPassword: replacement })).status).toBe(401);
    });

    it('refuses a wrong current password, an unchanged password and a weak new one', async () => {
      const wrong = await api().post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'not-the-password-1', newPassword: replacement });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('PASSWORD_CURRENT_INVALID');

      const same = await api().post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: original, newPassword: original });
      expect(same.status).toBe(400);
      expect(same.body.code).toBe('PASSWORD_UNCHANGED');

      const weak = await api().post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: original, newPassword: 'letmein12345' });
      expect(weak.status).toBe(400);
      expect(JSON.stringify(weak.body)).toMatch(/too common/);
      // Nothing changed: the original password still signs in.
      expect((await api().post('/api/auth/login').send({ email, password: original })).status).toBe(201);
    });

    it('changes the password, ends every session, and the new password signs in', async () => {
      const ok = await api().post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: original, newPassword: replacement });
      expect(ok.status).toBe(200);
      expect(ok.body.message).toMatch(/changed/i);

      // The session that made the change is over (tokenVersion bumped) ...
      expect((await api().get('/api/auth/profile').set('Authorization', `Bearer ${token}`)).status).toBe(401);
      // ... the old password is refused and the new one opens a session.
      expect((await api().post('/api/auth/login').send({ email, password: original })).status).toBe(401);
      const again = await api().post('/api/auth/login').send({ email, password: replacement });
      expect(again.status).toBe(201);
      expect((await api().get('/api/auth/profile').set('Authorization', `Bearer ${again.body.access_token}`)).status).toBe(200);
    });
  });
});
