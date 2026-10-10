import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfig } from '../config/domains/auth.config';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
}

interface GoogleTokenInfo {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  sub?: string;
}

/**
 * Verifies the Google-issued OpenID Connect token before using any identity
 * claim.  The browser must never be trusted to submit a Google account ID,
 * email, or display name on its own.
 */
@Injectable()
export class GoogleIdentityService {
  private readonly logger = new Logger(GoogleIdentityService.name);

  constructor(private readonly authConfig: AuthConfig) {}

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    // The client id is the token's required audience. Without it nothing can be verified: say so
    // (no deployment passed it to the API before roadmap 9.19, and every sign-in ended as a 500).
    const clientId = this.authConfig.googleClientId;
    if (!clientId) {
      throw new ServiceUnavailableException({ message: 'Google sign-in is not configured on this server (GOOGLE_CLIENT_ID).', code: 'GOOGLE_SIGNIN_NOT_CONFIGURED' });
    }

    let response: Response;
    try {
      response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
        { signal: AbortSignal.timeout(5_000) },
      );
    } catch (error) {
      this.logger.warn(`Google token verification request failed: ${String(error)}`);
      throw new UnauthorizedException('Unable to verify Google sign-in. Please try again.');
    }

    if (!response.ok) {
      throw new UnauthorizedException('Google sign-in token is invalid or expired.');
    }

    const token = (await response.json()) as GoogleTokenInfo;
    if (
      token.aud !== clientId ||
      token.email_verified !== true && token.email_verified !== 'true' ||
      !token.sub ||
      !token.email
    ) {
      throw new UnauthorizedException('Google sign-in token is not valid for this application.');
    }

    return {
      googleId: token.sub,
      email: token.email.toLowerCase(),
      name: token.name?.trim() || token.email.split('@')[0],
    };
  }
}
