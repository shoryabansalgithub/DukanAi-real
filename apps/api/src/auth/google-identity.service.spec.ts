import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfig, parseGoogleClientId } from '../config/domains/auth.config';
import { GoogleIdentityService } from './google-identity.service';

describe('GoogleIdentityService', () => {
  const config = { authDisabled: false, googleClientId: 'web-client-id' } as AuthConfig;
  const service = new GoogleIdentityService(config);
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns only a verified identity for this OAuth client', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        aud: 'web-client-id',
        sub: 'google-subject',
        email: 'USER@example.com',
        email_verified: 'true',
        name: 'User Name',
      }),
    });

    await expect(service.verifyIdToken('signed-id-token')).resolves.toEqual({
      googleId: 'google-subject',
      email: 'user@example.com',
      name: 'User Name',
    });
  });

  it('rejects an ID token issued for another OAuth client', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        aud: 'attacker-client-id',
        sub: 'google-subject',
        email: 'user@example.com',
        email_verified: true,
      }),
    });

    await expect(service.verifyIdToken('signed-id-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token Google marks invalid', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false });

    await expect(service.verifyIdToken('expired-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 503 GOOGLE_SIGNIN_NOT_CONFIGURED without a client id, before calling Google (roadmap 9.19)', async () => {
    global.fetch = jest.fn();
    const unconfigured = new GoogleIdentityService({ authDisabled: false } as AuthConfig);
    const outcome = unconfigured.verifyIdToken('signed-id-token');
    await expect(outcome).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(outcome).rejects.toMatchObject({ response: { code: 'GOOGLE_SIGNIN_NOT_CONFIGURED' } });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('treats a blank or template client id as Google sign-in off', () => {
    expect(parseGoogleClientId(undefined)).toBeUndefined();
    expect(parseGoogleClientId('  ')).toBeUndefined();
    expect(parseGoogleClientId('___REPLACE_ME_IN_PRODUCTION___')).toBeUndefined();
    expect(parseGoogleClientId('your_google_client_id.apps.googleusercontent.com')).toBeUndefined();
    expect(parseGoogleClientId(' 123-abc.apps.googleusercontent.com ')).toBe('123-abc.apps.googleusercontent.com');
  });
});
