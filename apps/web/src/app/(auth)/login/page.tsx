'use client';

import React, { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { motion } from 'framer-motion';
import { ShoppingBag, Lock, Mail, ArrowRight, AlertCircle } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { AUTH_DISABLED } from '@/lib/auth-bypass';

// Never statically generated — searchParams driven error display and real-time auth state.
export const dynamic = 'force-dynamic';
const googleOAuthEnabled = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === 'true';

function LoginPageContent() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();
  const { toast } = useToast();

  // Where to go after sign-in: the protected page the middleware bounced from,
  // restricted to same-origin paths so the parameter cannot redirect off-site.
  const rawCallback = searchParams.get('callbackUrl');
  const callbackUrl = rawCallback && rawCallback.startsWith('/') && !rawCallback.startsWith('//') ? rawCallback : '/dashboard';

  // If already authenticated (or auth is bypassed), redirect away from login
  useEffect(() => {
    if (AUTH_DISABLED || status === 'authenticated') {
      router.replace(callbackUrl);
    }
  }, [status, router, callbackUrl]);

  // Show error from NextAuth callback (e.g. OAuth failures)
  useEffect(() => {
    const authError = searchParams.get('error');
    if (authError) {
      const messages: Record<string, string> = {
        OAuthSignin: 'Could not start Google sign-in. Please try again.',
        OAuthCallback: 'Google sign-in failed. Please try again.',
        OAuthAccountNotLinked: 'This Google account is not linked. Sign in with email instead.',
        Callback: 'Authentication failed. Please try again.',
        default: 'An unexpected error occurred.',
      };
      setError(messages[authError] ?? messages.default);
    }
  }, [searchParams]);

  const handleCredentialsLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        // authorize() throws a descriptive message when the API is down;
        // NextAuth surfaces it via result.error. Anything else is bad credentials.
        if (result.error.includes('unreachable')) {
          setError(result.error);
        } else {
          setError('Invalid email or password. Please try again.');
        }
        return;
      }

      if (result?.ok) {
        toast('Welcome back!', 'success');
        router.push(callbackUrl);
      }
    } catch (err) {
      console.error('Sign-in request failed:', err);
      setError('Could not complete sign-in. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    if (!googleOAuthEnabled) {
      setError('Google sign-in is not configured for this deployment.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signIn('google', { callbackUrl });
    } catch (err) {
      console.error('Google sign-in failed:', err);
      setError('Could not connect to Google. Please try again.');
      setLoading(false);
    }
  };

  return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100 relative"
      >
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-[#8B5CF6] to-[#3B82F6]" />

        <div className="p-8 sm:p-10">
          {/* --- Logo --- */}
          <div className="flex justify-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center text-[#8B5CF6] shadow-inner">
              <ShoppingBag size={32} strokeWidth={2} />
            </div>
          </div>

          {/* --- Header --- */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">
              Welcome back
            </h1>
            <p className="text-sm text-gray-500 mt-2 font-medium">
              Log in to your DukaanAI terminal
            </p>
          </div>

          {/* --- Error banner --- */}
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="flex items-center gap-2.5 p-3 mb-6 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-700"
            >
              <AlertCircle size={16} className="shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}

          {/* --- Google sign-in --- */}
          {googleOAuthEnabled && <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 py-3 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 rounded-xl text-sm font-semibold text-gray-700 transition-all disabled:opacity-60 shadow-sm"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>}

          {/* --- Divider --- */}
          {googleOAuthEnabled && <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              or
            </span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>}

          {/* --- Email / password form --- */}
          <form onSubmit={handleCredentialsLogin} className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail
                  size={18}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@dukaan.ai"
                  autoComplete="email"
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                  required
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide">
                  Password
                </label>
                <a
                  href="#"
                  className="text-xs font-bold text-[#8B5CF6] hover:text-purple-700 transition-colors"
                >
                  Forgot?
                </a>
              </div>
              <div className="relative">
                <Lock
                  size={18}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-purple-500/30 flex items-center justify-center gap-2 disabled:opacity-70 group"
            >
              {loading ? 'Signing in…' : 'Sign In'}
              {!loading && (
                <ArrowRight
                  size={18}
                  className="group-hover:translate-x-1 transition-transform"
                />
              )}
            </button>
          </form>
          {/* --- Footer --- */}
          <div className="mt-8 text-center">
            <p className="text-xs text-gray-500 font-medium">
              Don&apos;t have an account?{' '}
              <Link href="/register" className="text-[#8B5CF6] font-bold hover:underline">
                Create your store
              </Link>
            </p>
          </div>
        </div>
      </motion.div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginPageContent />
    </Suspense>
  );
}
