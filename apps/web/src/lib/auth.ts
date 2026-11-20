import type { NextAuthOptions, User, Account, Profile } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { clientConfig, hasGoogleCredentials, serverConfig } from '../config/env';
import { decodeJwtExpiryMs } from './jwt';
import { RefreshHandoff } from './refresh-handoff';

// ---------------------------------------------------------------------------
// Augmented user payload — what our NestJS backend returns and what we store
// in the NextAuth JWT / session.  These fields do not exist on the upstream
// NextAuth User type, so we model them explicitly.
// ---------------------------------------------------------------------------
interface DukaanUser extends User {
  role: string;
  shopId: string;
  accessToken: string;
  refreshToken: string;
}

function isDukaanUser(u: User): u is DukaanUser {
  return 'accessToken' in u && 'refreshToken' in u && 'role' in u && 'shopId' in u;
}

// ---------------------------------------------------------------------------
// API helper — called from both the Credentials authorize and the Google
// signIn callback so the backend is always the single source of truth.
// ---------------------------------------------------------------------------
// Server-side calls may take a private route to the API (API_INTERNAL_URL,
// roadmap 7.3); the public URL is what the browser, and this message, use.
const API_URL = serverConfig.API_INTERNAL_URL ?? clientConfig.NEXT_PUBLIC_API_URL;


/** Message surfaced on the login form when the backend cannot be reached. */
export const API_UNREACHABLE_MESSAGE = `The DukaanAI API at ${clientConfig.NEXT_PUBLIC_API_URL} is unreachable. Make sure the backend server is running, then try again.`;

/** Refresh this long before the access token actually expires. */
const REFRESH_LEEWAY_MS = 60 * 1000;

/**
 * Fallback lifetime when the access token carries no readable `exp` claim.
 * Short on purpose: an unreadable token is refreshed eagerly rather than
 * trusted for long.
 */
const FALLBACK_ACCESS_LIFETIME_MS = 5 * 60 * 1000;

function accessTokenExpiryFor(accessToken: string): number {
  return decodeJwtExpiryMs(accessToken) ?? Date.now() + FALLBACK_ACCESS_LIFETIME_MS;
}

// ---------------------------------------------------------------------------
// The API rate-limits sign-in and refresh per client address. Every call below
// is made by this server, so without help the API would see one address for
// every user of the deployment. Forward the browser's address (Next.js fills
// `x-forwarded-for` from the socket when no proxy set it); the API honours it
// only where TRUST_PROXY covers this server.
// ---------------------------------------------------------------------------
async function forwardedClientHeaders(): Promise<Record<string, string>> {
  try {
    const { headers } = await import('next/headers');
    const forwardedFor = (await headers()).get('x-forwarded-for');
    return forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {};
  } catch {
    // next/headers unavailable outside a request scope — nothing to forward
    return {};
  }
}

type ProvisionResult =
  | { ok: true; user: DukaanUser }
  | { ok: false; reason: 'rejected' | 'unreachable'; status?: number; code?: string };

async function provisionUserFromBackend(
  payload: Record<string, unknown>,
): Promise<ProvisionResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/${'idToken' in payload ? 'google' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await forwardedClientHeaders()) },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // fetch only rejects on network-level failures — the API is down/unreachable.
    console.error(`Auth backend unreachable at ${API_URL}:`, error);
    return { ok: false, reason: 'unreachable' };
  }

  try {
    const data = await res.json();

    if (res.ok && data?.access_token) {
      return {
        ok: true,
        user: {
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          role: data.user.role,
          shopId: data.user.shopId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
        },
      };
    }
    console.error(`Auth backend rejected sign-in (HTTP ${res.status}):`, data);
    return { ok: false, reason: 'rejected', status: res.status, code: typeof data?.code === 'string' ? data.code : undefined };
  } catch (error) {
    console.error('Auth backend returned an unreadable response:', error);
    return { ok: false, reason: 'rejected', status: res.status };
  }
}

// ---------------------------------------------------------------------------
// Refresh-token exchange. `POST /api/auth/refresh { refresh_token }` returns a
// brand new `{ access_token, refresh_token, user }` pair and revokes the old
// refresh token. Because the old token is single-use, every JWT callback that
// still holds it (parallel `getSession()` calls, and the ones that arrive just
// after the first exchange with the browser's old cookie) must be answered
// with the one exchange's successor: see `refreshHandoff` below.
// ---------------------------------------------------------------------------
type RefreshOutcome =
  | { ok: true; accessToken: string; refreshToken: string; accessTokenExpires: number }
  | { ok: false };

// A rotated token's successor is handed to every caller that still holds the
// consumed token for a while (roadmap 9.17): sharing the exchange only while
// it was in flight signed the account out of everything after one token
// lifetime, because late callers with the old cookie tripped the API's reuse
// detection. Two minutes covers the slowest poll that can carry an old cookie.
const refreshHandoff = new RefreshHandoff<RefreshOutcome>({ graceMs: 2 * 60 * 1000 });

async function exchangeRefreshToken(refreshToken: string): Promise<RefreshOutcome> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await forwardedClientHeaders()) },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token || !data?.refresh_token) {
      console.error(`Refresh token exchange rejected (HTTP ${res.status}):`, data);
      return { ok: false };
    }
    return {
      ok: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accessTokenExpires: accessTokenExpiryFor(data.access_token),
    };
  } catch (error) {
    console.error('Refresh token exchange failed:', error);
    return { ok: false };
  }
}

function refreshOnce(refreshToken: string): Promise<RefreshOutcome> {
  return refreshHandoff.once(refreshToken, () => exchangeRefreshToken(refreshToken));
}

async function refreshAccessToken(token: JWT): Promise<JWT> {
  if (!token.refreshToken) {
    return { ...token, error: 'RefreshAccessTokenError' };
  }
  const outcome = await refreshOnce(token.refreshToken);
  if (!outcome.ok) {
    return { ...token, error: 'RefreshAccessTokenError' };
  }
  return {
    ...token,
    accessToken: outcome.accessToken,
    refreshToken: outcome.refreshToken,
    accessTokenExpires: outcome.accessTokenExpires,
    error: undefined,
  };
}

// ---------------------------------------------------------------------------
// NextAuth configuration
// ---------------------------------------------------------------------------
export const authOptions: NextAuthOptions = {
  secret: serverConfig.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },

  providers: [
    // ---- Email / password ----
    CredentialsProvider({
      id: 'credentials',
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const result = await provisionUserFromBackend({
          email: credentials.email,
          password: credentials.password,
        });
        if (result.ok) return result.user;
        if (result.reason === 'unreachable') {
          // Thrown message becomes `result.error` on the client so the login
          // form can distinguish "API down" from "wrong password".
          throw new Error(API_UNREACHABLE_MESSAGE);
        }
        return null;
      },
    }),

    // ---- Google OAuth (only with real credentials; a template placeholder leaves it off) ----
    ...(hasGoogleCredentials(serverConfig)
      ? [GoogleProvider({
          clientId: serverConfig.GOOGLE_CLIENT_ID,
          clientSecret: serverConfig.GOOGLE_CLIENT_SECRET,
          authorization: {
            params: {
              prompt: 'select_account',
              access_type: 'offline',
            },
          },
        })]
      : []),
  ],

  callbacks: {
    // ---- signIn — provision user in our backend on first Google sign-in ----
    async signIn({ user, account }: { user: User; account: Account | null; profile?: Profile }) {
      // Credentials provider already handled in authorize — allow through
      if (account?.provider === 'credentials') return true;

      // Google OAuth — only the Google-issued ID token is sent; the API
      // verifies it and derives the identity itself. Returning false sends
      // the browser back to /login?error=AccessDenied, which is right only
      // for the API's 409 (the address has a password account); any other
      // failure names its own reason (roadmap 9.19).
      if (account?.provider === 'google') {
        if (!account.id_token) return '/login?error=OAuthCallback';
        const provisioned = await provisionUserFromBackend({ idToken: account.id_token });

        if (!provisioned.ok) {
          if (provisioned.status === 409) return false;
          if (provisioned.code === 'GOOGLE_SIGNIN_NOT_CONFIGURED') return '/login?error=GoogleNotConfigured';
          return provisioned.reason === 'unreachable' ? '/login?error=GoogleApiUnreachable' : '/login?error=OAuthCallback';
        }

        // Mutate the user object so the jwt callback receives our fields.
        // NextAuth v4 copies properties from user → token.user in the jwt
        // callback, so we must enrich user *before* that callback fires.
        Object.assign(user, provisioned.user);
        return true;
      }

      return false;
    },

    // ---- jwt — persist Dukaan fields and keep the access token fresh ----
    async jwt({ token, user }) {
      // Initial sign-in: copy the backend tokens into the NextAuth JWT.
      if (user && isDukaanUser(user)) {
        return {
          ...token,
          id: user.id,
          role: user.role,
          shopId: user.shopId,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          accessTokenExpires: accessTokenExpiryFor(user.accessToken),
          error: undefined,
        };
      }

      // Tokens minted before expiry tracking existed: derive it from the JWT.
      if (token.accessToken && typeof token.accessTokenExpires !== 'number') {
        token.accessTokenExpires = accessTokenExpiryFor(token.accessToken);
      }

      // Still comfortably valid: nothing to do.
      if (
        token.accessToken &&
        typeof token.accessTokenExpires === 'number' &&
        Date.now() < token.accessTokenExpires - REFRESH_LEEWAY_MS
      ) {
        return token;
      }

      // Within 60 s of expiry (or already expired): rotate the pair.
      return refreshAccessToken(token);
    },

    // ---- session — expose Dukaan fields to the client ----
    async session({ session, token }) {
      session.user.id = token.id as string;
      session.user.role = token.role as string;
      session.user.shopId = token.shopId as string;
      session.accessToken = token.accessToken;
      session.accessTokenExpires = token.accessTokenExpires;
      session.error = token.error;
      return session;
    },
  },

  // Debug only in development
  debug: serverConfig.NODE_ENV === 'development',
};
