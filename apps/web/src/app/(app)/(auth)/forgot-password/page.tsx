'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowLeft, KeyRound, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';
import { clientConfig } from '@/config/env';

const API_URL = clientConfig.NEXT_PUBLIC_API_URL;

/**
 * Forgot-password (roadmap 6.7): `POST /auth/forgot-password` answers the same
 * message whatever the address, so the page never reveals whether an account
 * exists. The link in the email opens /reset-password?token=….
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string | string[] };
      if (!res.ok) {
        setError(res.status === 503 ? 'Password reset emails are not configured on this server. Ask the shop owner.' : Array.isArray(data.message) ? data.message.join('. ') : data.message ?? 'Could not send the reset link. Please try again.');
        return;
      }
      setSentMessage(typeof data.message === 'string' ? data.message : 'If an account exists for that email, a reset link has been sent.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100 relative">
      <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-[#8B5CF6] to-[#3B82F6]" />
      <div className="p-8 sm:p-10">
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center text-[#8B5CF6] shadow-inner">
            <KeyRound size={32} strokeWidth={2} />
          </div>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Forgot your password?</h1>
          <p className="text-sm text-gray-500 mt-2 font-medium">Enter your email and we will send a link to set a new one.</p>
        </div>

        {error && (
          <div role="alert" className="flex items-center gap-2.5 p-3 mb-6 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-700">
            <AlertCircle size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {sentMessage ? (
          <div role="status" data-testid="reset-link-sent" className="flex items-start gap-2.5 p-4 bg-green-50 border border-green-200 rounded-xl text-sm font-medium text-green-800">
            <CheckCircle2 size={18} className="shrink-0 mt-0.5" />
            <span>{sentMessage} The link works for one hour.</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="forgot-email" className="block text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">Email Address</label>
              <div className="relative">
                <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@dukaan.ai"
                  autoComplete="email"
                  required
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all text-gray-800"
                />
              </div>
            </div>
            <button type="submit" disabled={loading} className="w-full py-3 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-xl text-sm font-bold shadow-lg shadow-purple-500/30 transition-all disabled:opacity-60">
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-gray-500">
          <Link href="/login" className="inline-flex items-center gap-1 font-bold text-[#8B5CF6] hover:text-purple-700">
            <ArrowLeft size={14} /> Back to sign in
          </Link>
        </p>
      </div>
    </motion.div>
  );
}
