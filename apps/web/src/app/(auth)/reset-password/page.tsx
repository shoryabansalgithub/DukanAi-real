'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Lock, ShieldCheck } from 'lucide-react';
import { clientConfig } from '@/config/env';

const API_URL = clientConfig.NEXT_PUBLIC_API_URL;
const TOKEN = /^[0-9a-f]{64}$/i;

/** Reset-password (roadmap 6.7): the token comes from the emailed link; a success ends every session of the account. */
function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = (searchParams.get('token') ?? '').trim();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const tokenValid = TOKEN.test(token);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8 || password.length > 72) {
      setError('The password must be between 8 and 72 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string | string[] };
      if (!res.ok) {
        setError(Array.isArray(data.message) ? data.message.join('. ') : data.message ?? 'This reset link is invalid or has expired.');
        return;
      }
      setDone(typeof data.message === 'string' ? data.message : 'Your password has been changed.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800';

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100 relative">
      <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-[#8B5CF6] to-[#3B82F6]" />
      <div className="p-8 sm:p-10">
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center text-[#8B5CF6] shadow-inner">
            <ShieldCheck size={32} strokeWidth={2} />
          </div>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Set a new password</h1>
          <p className="text-sm text-gray-500 mt-2 font-medium">Every device signed in to this account will be signed out.</p>
        </div>

        {!tokenValid && !done && (
          <div role="alert" className="flex items-center gap-2.5 p-3 mb-6 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-700">
            <AlertCircle size={16} className="shrink-0" />
            <span>This link is incomplete. Open the link from your email, or <Link href="/forgot-password" className="underline font-bold">request a new one</Link>.</span>
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-center gap-2.5 p-3 mb-6 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-700">
            <AlertCircle size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {done ? (
          <div role="status" data-testid="reset-done" className="space-y-6">
            <div className="flex items-start gap-2.5 p-4 bg-green-50 border border-green-200 rounded-xl text-sm font-medium text-green-800">
              <CheckCircle2 size={18} className="shrink-0 mt-0.5" />
              <span>{done}</span>
            </div>
            <Link href="/login" className="block w-full py-3 text-center bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-xl text-sm font-bold shadow-lg shadow-purple-500/30 transition-all">
              Sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="reset-password" className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">New password</label>
              <div className="relative">
                <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 8 characters" autoComplete="new-password" minLength={8} maxLength={72} required disabled={!tokenValid} className={inputClass} />
              </div>
            </div>
            <div>
              <label htmlFor="reset-confirm" className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">Confirm password</label>
              <div className="relative">
                <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input id="reset-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat the password" autoComplete="new-password" minLength={8} maxLength={72} required disabled={!tokenValid} className={inputClass} />
              </div>
            </div>
            <button type="submit" disabled={loading || !tokenValid} className="w-full py-3 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-xl text-sm font-bold shadow-lg shadow-purple-500/30 transition-all disabled:opacity-60">
              {loading ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-gray-500">
          <Link href="/login" className="font-bold text-[#8B5CF6] hover:text-purple-700">Back to sign in</Link>
        </p>
      </div>
    </motion.div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="p-8 flex justify-center"><div className="h-8 w-8 animate-spin rounded-full border-b-2 border-[#8B5CF6]" /></div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
