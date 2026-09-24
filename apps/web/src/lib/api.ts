import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import type { Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';

import { clientConfig, serverConfig } from '../config/env';
import { decodeJwtExpiryMs } from './jwt';

const API_URL = clientConfig.NEXT_PUBLIC_API_URL;

const apiClient: AxiosInstance = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---------------------------------------------------------------------------
// Client-side access-token cache.
//
// `getSession()` is a network round-trip to /api/auth/session (and runs the
// NextAuth jwt callback, which may hit the API's refresh endpoint). Calling it
// on every request is wasteful, so the resolved token is cached in memory with
// its expiry and only re-read when it is about to expire or when the API says
// it is no longer valid (401).
// ---------------------------------------------------------------------------
interface CachedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Treat the cached token as stale this long before it actually expires. */
const CACHE_LEEWAY_MS = 30 * 1000;
/** Lifetime assumed for a token whose `exp` claim cannot be read. */
const FALLBACK_LIFETIME_MS = 60 * 1000;

let cachedToken: CachedToken | null = null;
let inflightSessionRead: Promise<string | null> | null = null;

function isCacheFresh(): boolean {
  return cachedToken !== null && Date.now() < cachedToken.expiresAt - CACHE_LEEWAY_MS;
}

/** Drops the cached access token so the next request re-reads the session. */
export function invalidateTokenCache(): void {
  cachedToken = null;
}

async function readSessionToken(): Promise<string | null> {
  const { getSession } = await import('next-auth/react');
  const session = (await getSession()) as Session | null;
  const token = session?.accessToken ?? null;
  if (!token) {
    cachedToken = null;
    return null;
  }
  const expiresAt =
    session?.accessTokenExpires ?? decodeJwtExpiryMs(token) ?? Date.now() + FALLBACK_LIFETIME_MS;
  cachedToken = { token, expiresAt };
  return token;
}

/**
 * Returns the current access token on the client, reading the NextAuth session
 * at most once concurrently. `force` bypasses the cache (used after a 401).
 */
async function resolveClientToken(force = false): Promise<string | null> {
  if (!force && isCacheFresh() && cachedToken) {
    return cachedToken.token;
  }
  if (!inflightSessionRead) {
    inflightSessionRead = readSessionToken().finally(() => {
      inflightSessionRead = null;
    });
  }
  return inflightSessionRead;
}

// ---------------------------------------------------------------------------
// Isomorphic token resolution — extracts the NestJS access token from the
// NextAuth session (client, cached) or JWT cookie (server).
// ---------------------------------------------------------------------------
async function resolveToken(): Promise<string | null> {
  if (typeof window !== 'undefined') {
    return resolveClientToken();
  }

  // Server-side — decode the NextAuth JWT cookie directly
  try {
    const { cookies } = await import('next/headers');
    const { getToken } = await import('next-auth/jwt');
    const cookieStore = await cookies();

    const cookieMap: Record<string, string> = {};
    for (const c of cookieStore.getAll()) {
      cookieMap[c.name] = c.value;
    }

    // next-auth v4 getToken types expect IncomingMessage | NextApiRequest |
    // NextRequest, but at runtime it only accesses req.cookies — the plain
    // object is compatible at this library boundary.
    const token = (await getToken({
      req: { cookies: cookieMap },
      secret: serverConfig.NEXTAUTH_SECRET,
    } as Parameters<typeof getToken>[0])) as JWT | null;
    return token?.accessToken ?? null;
  } catch {
    // next/headers unavailable at build-time — no token to inject
    return null;
  }
}

// ---- Request interceptor — inject Bearer token ----
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const token = await resolveToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// ---- Response interceptor — recover from a stale token once, then sign out. ----
//
// On the first 401 the cached token is dropped, the session is re-read (which
// lets NextAuth rotate the pair via the refresh token) and the request is
// retried once with the new token. Only when that retry also returns 401 is
// the session considered dead and the user signed out. Guests without a
// session are never redirected: the public shell must stay browsable.
interface RetryableRequestConfig extends InternalAxiosRequestConfig {
  _retriedAfter401?: boolean;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    if (typeof window === 'undefined' || error.response?.status !== 401) {
      return Promise.reject(error);
    }

    const original = error.config as RetryableRequestConfig | undefined;
    if (!original) {
      return Promise.reject(error);
    }

    if (original._retriedAfter401) {
      // A freshly resolved token was rejected too: the session is unusable.
      invalidateTokenCache();
      const { signOut } = await import('next-auth/react');
      await signOut({ callbackUrl: '/login' });
      return Promise.reject(error);
    }

    invalidateTokenCache();
    const token = await resolveClientToken(true);
    if (!token) {
      // No session at all (guest) — nothing to retry with, nothing to sign out of.
      return Promise.reject(error);
    }

    original._retriedAfter401 = true;
    original.headers.Authorization = `Bearer ${token}`;
    return apiClient(original);
  },
);

export default apiClient;
