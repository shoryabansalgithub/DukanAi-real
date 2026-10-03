'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { motion } from 'framer-motion';
import { Lock, Mail, User, Store, ArrowRight, AlertCircle, KeyRound } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';

import { clientConfig } from '@/config/env';

const API_URL = clientConfig.NEXT_PUBLIC_API_URL;

export const dynamic = 'force-dynamic';
const googleOAuthEnabled = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === 'true';

/** An invitation code is 64 hex characters (the API refuses anything else). */
const INVITE_TOKEN = /^[0-9a-f]{64}$/;

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shopName, setShopName] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();
  const { toast } = useToast();

  // Roadmap 6.1: the invitation email links here with `?invite=<code>`; the
  // invitee joins the inviter's shop instead of creating a new one. The code
  // can also be pasted by hand.
  useEffect(() => {
    const fromLink = (searchParams.get('invite') ?? '').trim().toLowerCase();
    if (fromLink) setInviteToken(fromLink);
  }, [searchParams]);
  const joining = inviteToken.length > 0;

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/dashboard');
    }
  }, [status, router]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (joining && !INVITE_TOKEN.test(inviteToken)) {
      setError('The invitation code must be the 64-character code from your invitation email.');
      return;
    }
    setLoading(true);

    try {
      const res = joining
        ? await fetch(`${API_URL}/invitations/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: inviteToken, name, password }),
          })
        : await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, shopName }),
          });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          setError('An account with this email already exists.');
        } else if (joining && res.status === 404) {
          setError('This invitation code is invalid or has expired. Ask the shop owner for a new invitation.');
        } else if (data?.message) {
          setError(Array.isArray(data.message) ? data.message.join('. ') : data.message);
        } else {
          setError('Registration failed. Please try again.');
        }
        return;
      }

      // An accepted invitation answers the created account, whose email is the invited address.
      const signInEmail = joining ? String(data?.email ?? '') : email;
      const result = await signIn('credentials', {
        email: signInEmail,
        password,
        redirect: false,
      });

      if (result?.error) {
        toast('Account created! Please sign in.', 'success');
        router.push('/login');
        return;
      }

      toast(joining ? 'Welcome aboard! You have joined the shop.' : 'Your store is ready!', 'success');
      router.push('/dashboard');
    } catch (err) {
      console.error(`Registration request to ${API_URL}/auth/register failed:`, err);
      setError(`The DukaanAI API at ${API_URL} is unreachable. Make sure the backend server is running, then try again.`);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignup = async () => {
    if (!googleOAuthEnabled) {
      setError('Google sign-in is not configured for this deployment.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signIn('google', { callbackUrl: '/dashboard' });
    } catch {
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
            <Store size={32} strokeWidth={2} />
          </div>
        </div>

        {/* --- Header --- */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">
            {joining ? 'Join your shop' : 'Create your store'}
          </h1>
          <p className="text-sm text-gray-500 mt-2 font-medium">
            {joining ? 'Set a name and password for the account you were invited to' : 'Set up your DukaanAI account in seconds'}
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

        {/* --- Google sign-up --- */}
        {googleOAuthEnabled && !joining && <button
          type="button"
          onClick={handleGoogleSignup}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 py-3 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 rounded-xl text-sm font-semibold text-gray-700 transition-all disabled:opacity-60 shadow-sm"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Continue with Google
        </button>}

        {/* --- Divider --- */}
        {googleOAuthEnabled && !joining && <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            or
          </span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>}

        {/* --- Registration form --- */}
        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">
              Invitation Code <span className="normal-case font-medium text-gray-400">(only if you were invited)</span>
            </label>
            <div className="relative">
              <KeyRound size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={inviteToken}
                onChange={(e) => setInviteToken(e.target.value.trim().toLowerCase())}
                placeholder="Paste the code from your invitation email"
                autoComplete="off"
                spellCheck={false}
                aria-label="Invitation code"
                className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800 font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">
              Full Name
            </label>
            <div className="relative">
              <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Rajesh Kumar"
                autoComplete="name"
                className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                required
              />
            </div>
          </div>

          {!joining && (
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">
                Shop Name
              </label>
              <div className="relative">
                <Store size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                  placeholder="Kumar General Store"
                  autoComplete="organization"
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                  required
                />
              </div>
            </div>
          )}

          {!joining && (
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="rajesh@example.com"
                  autoComplete="email"
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                  required
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">
              Password
            </label>
            <div className="relative">
              <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
                minLength={8}
                className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-purple-500/30 flex items-center justify-center gap-2 disabled:opacity-70 group mt-2"
          >
            {loading ? (joining ? 'Joining…' : 'Creating your store…') : joining ? 'Join Shop' : 'Create Store'}
            {!loading && (
              <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
            )}
          </button>
        </form>

        {/* --- Footer --- */}
        <div className="mt-8 text-center">
          <p className="text-xs text-gray-500 font-medium">
            Already have a store?{' '}
            <Link href="/login" className="text-[#8B5CF6] font-bold hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </motion.div>
  );
}
