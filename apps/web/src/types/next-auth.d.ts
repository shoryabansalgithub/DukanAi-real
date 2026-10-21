import { DefaultSession } from 'next-auth';

/** Set on the session/JWT when the refresh-token exchange fails. */
export type SessionErrorCode = 'RefreshAccessTokenError';

declare module 'next-auth' {
  interface Session {
    accessToken?: string;
    /** Epoch milliseconds at which `accessToken` expires. */
    accessTokenExpires?: number;
    /** Present when the server-side refresh failed; the client must sign in again. */
    error?: SessionErrorCode;
    user: {
      id: string;
      role: string;
      shopId: string;
    } & DefaultSession['user'];
  }

  interface User {
    role: string;
    shopId: string;
    accessToken: string;
    refreshToken: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: string;
    shopId?: string;
    accessToken?: string;
    refreshToken?: string;
    /** Epoch milliseconds at which `accessToken` expires. */
    accessTokenExpires?: number;
    error?: SessionErrorCode;
  }
}
