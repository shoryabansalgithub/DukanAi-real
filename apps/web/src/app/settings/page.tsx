'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import { Store, AlertCircle, ShieldCheck, LogOut, Monitor, Bell, Users } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { sessionsApi, shopApi, type SessionView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { AUTH_DISABLED } from '@/lib/auth-bypass';
import { signOutEverywhere } from '@/lib/sign-out';
import { INDIAN_STATES } from '@/components/pos/indian-states';
import { dateTime } from '@/components/pos/format';

/**
 * Settings (roadmap 6.3). "Shop Profile" writes every field `PATCH /shops/me`
 * accepts; the shop's state is what decides IGST versus CGST+SGST on a sale
 * (the API compares it with the customer's state), so it is a picker from
 * the same list the customers page uses. The side menu opens real panels:
 * Account & Security lists and ends the caller's own sessions, the two
 * team / notification entries lead to their pages. There is no plan or
 * subscription model, so the former "Billing & Plans" entry is gone.
 */
type SettingsSection = 'profile' | 'account';

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: 'profile', label: 'Shop Profile' },
  { key: 'account', label: 'Account & Security' },
];

const LINKS: Array<{ label: string; href: string }> = [
  { label: 'Notifications', href: '/notifications' },
  { label: 'Team Management', href: '/employees' },
];

const PROFILE_ROLES = new Set(['MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);
const PINCODE = /^[1-9][0-9]{5}$/;
const PHONE = /^[0-9+\-\s()]{6,20}$/;

const menuClass = (active: boolean) =>
  `w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-colors ${active ? 'bg-[#8B5CF6] text-white shadow-md' : 'text-gray-600 hover:bg-gray-100'}`;

function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const os = /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function SettingsContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const canEditProfile = AUTH_DISABLED || (!!session?.user?.role && PROFILE_ROLES.has(session.user.role.toUpperCase()));

  const requested = searchParams.get('section');
  const [section, setSection] = useState<SettingsSection>(requested === 'account' ? 'account' : 'profile');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [shopName, setShopName] = useState('');
  const [gstin, setGstin] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [pincode, setPincode] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    shopApi
      .me()
      .then((data) => {
        setShopName(data.name ?? '');
        setGstin(data.settings?.gstin ?? '');
        setAddress(data.address ?? '');
        setCity(data.city ?? '');
        setState(data.state ?? '');
        setPincode(data.pincode ?? '');
        setPhone(data.phone ?? '');
        setEmail(data.email ?? '');
      })
      .catch((err) => setLoadError(describeApiError(err, 'Loading shop profile (GET /shops/me)')))
      .finally(() => setLoading(false));
  }, []);

  const loadSessions = useCallback(() => {
    setSessionsError(null);
    sessionsApi
      .list()
      .then(setSessions)
      .catch((err) => setSessionsError(describeApiError(err, 'Loading sessions (GET /auth/sessions)')));
  }, []);

  useEffect(() => {
    if (section === 'account') loadSessions();
  }, [section, loadSessions]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPincode = pincode.trim();
    const trimmedPhone = phone.trim();
    const trimmedGstin = gstin.trim().toUpperCase();
    if (trimmedPincode && !PINCODE.test(trimmedPincode)) {
      toast('The PIN code must be 6 digits.', 'error');
      return;
    }
    if (trimmedPhone && !PHONE.test(trimmedPhone)) {
      toast('Enter a valid phone number.', 'error');
      return;
    }
    if (trimmedGstin && !/^[0-9A-Z]{15}$/.test(trimmedGstin)) {
      toast('The GSTIN must be 15 letters and digits.', 'error');
      return;
    }
    try {
      setSaving(true);
      const saved = await shopApi.update({
        name: shopName.trim(),
        address: address.trim(),
        city: city.trim(),
        state,
        pincode: trimmedPincode,
        phone: trimmedPhone,
        email: email.trim(),
        gstin: trimmedGstin,
      });
      setShopName(saved.name);
      setState(saved.state ?? '');
      toast(saved.state ? `Shop profile saved. Sales to customers outside ${saved.state} will carry IGST.` : 'Shop profile saved. Set the state so inter-state sales carry IGST.', saved.state ? 'success' : 'warning');
    } catch (err) {
      toast(describeApiError(err, 'Saving shop profile (PATCH /shops/me)'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (target: SessionView) => {
    try {
      setRevoking(target.id);
      await sessionsApi.revoke(target.id);
      setSessions((current) => (current ?? []).filter((s) => s.familyId !== target.familyId));
      toast('Session ended', 'success');
    } catch (err) {
      toast(describeApiError(err, 'Ending a session (DELETE /auth/sessions/:id)'), 'error');
    } finally {
      setRevoking(null);
    }
  };

  const inputClass = 'w-full mt-1 border border-gray-200 rounded-lg p-3 bg-gray-50';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Manage your shop profile, team members, and billing.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="col-span-1 space-y-2" data-testid="settings-menu">
          {SECTIONS.map((item) => (
            <button key={item.key} type="button" onClick={() => setSection(item.key)} aria-current={section === item.key ? 'page' : undefined} className={menuClass(section === item.key)}>
              {item.label}
            </button>
          ))}
          {LINKS.map((item) => (
            <button key={item.href} type="button" onClick={() => router.push(item.href)} className={menuClass(false)}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="col-span-2">
          {section === 'profile' && (
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <Store size={24} className="text-[#8B5CF6]" />
                <h2 className="text-xl font-bold text-gray-800">Shop Profile</h2>
              </div>

              {loading && <p className="text-sm text-gray-500">Loading shop profile...</p>}

              {!loading && loadError && (
                <div className="flex items-center gap-3 rounded-lg border border-red-100 bg-red-50 p-4 text-sm text-red-600">
                  <AlertCircle size={16} className="flex-shrink-0" />
                  <span>{loadError}</span>
                </div>
              )}

              {!loading && !loadError && (
                <form onSubmit={handleSave} className="space-y-4">
                  <fieldset disabled={!canEditProfile || saving} className="space-y-4 disabled:opacity-80">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="shop-name" className="text-sm font-bold text-gray-700">Shop Name</label>
                        <input id="shop-name" type="text" value={shopName} onChange={(e) => setShopName(e.target.value)} required className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="shop-gstin" className="text-sm font-bold text-gray-700">GSTIN</label>
                        <input id="shop-gstin" type="text" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="Not set" maxLength={15} className={`${inputClass} uppercase`} />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="shop-address" className="text-sm font-bold text-gray-700">Shop Address</label>
                      <textarea id="shop-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Not set" className={`${inputClass} h-24`}></textarea>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="shop-city" className="text-sm font-bold text-gray-700">City</label>
                        <input id="shop-city" type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Not set" maxLength={100} className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="shop-state" className="text-sm font-bold text-gray-700">State</label>
                        <select id="shop-state" value={state} onChange={(e) => setState(e.target.value)} className={inputClass}>
                          <option value="">Not set</option>
                          {INDIAN_STATES.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <p className="text-xs text-gray-500 mt-1">Decides the tax split: a customer in another state is charged IGST instead of CGST + SGST.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label htmlFor="shop-pincode" className="text-sm font-bold text-gray-700">PIN Code</label>
                        <input id="shop-pincode" type="text" inputMode="numeric" value={pincode} onChange={(e) => setPincode(e.target.value)} placeholder="Not set" maxLength={6} className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="shop-phone" className="text-sm font-bold text-gray-700">Phone</label>
                        <input id="shop-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Not set" maxLength={20} className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="shop-email" className="text-sm font-bold text-gray-700">Email</label>
                        <input id="shop-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Not set" maxLength={191} className={inputClass} />
                      </div>
                    </div>
                  </fieldset>

                  {!canEditProfile && (
                    <p className="text-xs text-gray-500">Only managers, admins and the owner can change the shop profile.</p>
                  )}

                  <div className="pt-4 border-t border-gray-100 flex justify-end">
                    <button type="submit" disabled={saving || !canEditProfile} className="bg-[#8B5CF6] text-white px-6 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-purple-500/30 hover:bg-[#7C3AED] transition-colors disabled:opacity-60">
                      {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </form>
              )}
            </Card>
          )}

          {section === 'account' && (
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <ShieldCheck size={24} className="text-[#8B5CF6]" />
                <h2 className="text-xl font-bold text-gray-800">Account & Security</h2>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Signed in as</p>
                  <p className="font-bold text-gray-800">{session?.user?.name ?? (AUTH_DISABLED ? 'System user (auth bypass)' : '—')}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{session?.user?.email ?? ''}</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Role</p>
                  <p className="font-bold text-gray-800">{session?.user?.role ?? (AUTH_DISABLED ? 'OWNER' : '—')}</p>
                  <p className="text-xs text-gray-500 mt-0.5">Passwords are set at registration or from an invitation; there is no in-app password change yet.</p>
                </div>
              </div>

              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Monitor size={16} /> Active sessions</h3>
                <button type="button" onClick={loadSessions} className="text-xs font-bold text-[#8B5CF6] hover:underline">Refresh</button>
              </div>

              {sessionsError && (
                <div className="flex items-center gap-3 rounded-lg border border-red-100 bg-red-50 p-4 text-sm text-red-600 mb-4">
                  <AlertCircle size={16} className="flex-shrink-0" />
                  <span>{sessionsError}</span>
                </div>
              )}
              {!sessionsError && sessions === null && <p className="text-sm text-gray-500">Loading sessions...</p>}
              {!sessionsError && sessions !== null && sessions.length === 0 && (
                <p className="text-sm text-gray-500">{AUTH_DISABLED ? 'The auth bypass is on: requests carry no session, so there is nothing to list.' : 'No active sessions.'}</p>
              )}
              {!sessionsError && sessions !== null && sessions.length > 0 && (
                <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden" data-testid="session-list">
                  {sessions.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div>
                        <p className="font-bold text-gray-800">{describeAgent(item.userAgent)}</p>
                        <p className="text-xs text-gray-500">{item.ipAddress ?? 'IP unknown'} · signed in {dateTime(item.createdAt)} · expires {dateTime(item.absoluteExpiresAt)}</p>
                      </div>
                      <button
                        type="button"
                        disabled={revoking === item.id}
                        onClick={() => void handleRevoke(item)}
                        className="text-xs font-bold text-red-600 hover:bg-red-50 px-3 py-1.5 rounded-lg border border-red-100 disabled:opacity-50"
                      >
                        {revoking === item.id ? 'Ending…' : 'End session'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="pt-6 mt-6 border-t border-gray-100 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
                <p className="text-xs text-gray-500">Signing out everywhere ends this session on the API; other devices stop working at their next request.</p>
                <button type="button" onClick={() => void signOutEverywhere()} className="flex items-center justify-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-xl text-sm font-bold hover:bg-gray-50">
                  <LogOut size={16} /> Sign out
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-6">
                <button type="button" onClick={() => router.push('/employees')} className="flex items-center gap-3 bg-gray-50 hover:bg-gray-100 p-4 rounded-xl border border-gray-100 text-left">
                  <Users size={18} className="text-[#8B5CF6]" />
                  <span className="text-sm font-bold text-gray-800">Team management</span>
                </button>
                <button type="button" onClick={() => router.push('/notifications')} className="flex items-center gap-3 bg-gray-50 hover:bg-gray-100 p-4 rounded-xl border border-gray-100 text-left">
                  <Bell size={18} className="text-[#8B5CF6]" />
                  <span className="text-sm font-bold text-gray-800">Notifications</span>
                </button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** `useSearchParams` needs a Suspense boundary for the static shell (`next build`). */
export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-8 flex justify-center"><div className="h-8 w-8 animate-spin rounded-full border-b-2 border-[#8B5CF6]" /></div>}>
      <SettingsContent />
    </Suspense>
  );
}
