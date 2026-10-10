import { signOut } from 'next-auth/react';
import apiClient from './api';

/**
 * Signs the user out everywhere it matters: the API ends the session family
 * behind the current access token (its refresh token and access tokens stop
 * working at once), then NextAuth drops the browser session. The API call is
 * best effort: a dead or unreachable API must not keep the user signed in.
 */
export async function signOutEverywhere(callbackUrl = '/login'): Promise<void> {
  try {
    await apiClient.post('/auth/logout');
  } catch {
    // Already signed out on the API, or the API is unreachable: the local sign-out still proceeds.
  }
  await signOut({ callbackUrl });
}
