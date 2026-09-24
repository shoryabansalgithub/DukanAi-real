'use client';

import React, { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { customersApi, type CustomerInput, type CustomerView } from '@/lib/api-client';
import { describeApiError, getApiErrorCode } from '@/lib/api-error';
import { INDIAN_STATES } from './indian-states';

const inputClass =
  'w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6] transition-all disabled:bg-gray-50 disabled:text-gray-500';
const labelClass = 'text-xs font-bold text-gray-600 uppercase tracking-wide';

interface FormState {
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  creditLimit: string;
  notes: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  state: '',
  creditLimit: '',
  notes: '',
  isActive: true,
};

function formFromCustomer(customer: CustomerView): FormState {
  return {
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    city: customer.city,
    state: customer.state,
    creditLimit: String(customer.creditLimit),
    notes: customer.notes ?? '',
    isActive: customer.isActive,
  };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface CustomerFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  /** Required in edit mode. */
  customer?: CustomerView | null;
  onClose: () => void;
  onSaved: (customer: CustomerView) => void;
}

/**
 * Create (`POST /customers`) or edit (`PATCH /customers/:id`) a customer.
 * Every field from contract §4 is exposed; the credit limit is left blank on
 * create so the server default applies.
 */
export function CustomerFormModal({ isOpen, mode, customer, onClose, onSaved }: CustomerFormModalProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(mode === 'edit' && customer ? formFromCustomer(customer) : EMPTY_FORM);
    setFormError(null);
    setSubmitting(false);
  }, [isOpen, mode, customer]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const name = form.name.trim();
    const phone = form.phone.trim();
    if (!name || !phone) {
      setFormError('Name and phone are required.');
      return;
    }
    const creditLimitRaw = form.creditLimit.trim();
    const creditLimit = creditLimitRaw === '' ? undefined : Number(creditLimitRaw);
    if (creditLimit !== undefined && (!Number.isFinite(creditLimit) || creditLimit < 0)) {
      setFormError('Credit limit must be zero or a positive amount.');
      return;
    }

    const payload: CustomerInput = {
      name,
      phone,
      email: optional(form.email),
      address: optional(form.address),
      city: optional(form.city),
      state: optional(form.state),
      creditLimit,
      notes: optional(form.notes),
    };

    setSubmitting(true);
    setFormError(null);
    try {
      const saved =
        mode === 'edit' && customer
          ? await customersApi.update(customer.id, { ...payload, isActive: form.isActive })
          : await customersApi.create(payload);
      toast(mode === 'edit' ? 'Customer updated' : 'Customer added', 'success');
      onSaved(saved);
      onClose();
    } catch (error) {
      const code = getApiErrorCode(error);
      const operation = mode === 'edit' ? 'Updating customer (PATCH /customers/:id)' : 'Saving customer (POST /customers)';
      const message = describeApiError(error, operation);
      setFormError(code ? `${message} [${code}]` : message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={mode === 'edit' ? 'Edit customer' : 'Add new customer'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="customer-name" className={labelClass}>Name *</label>
            <input
              id="customer-name"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              required
              maxLength={120}
              autoFocus
              className={inputClass}
              disabled={submitting}
            />
          </div>
          <div>
            <label htmlFor="customer-phone" className={labelClass}>Phone *</label>
            <input
              id="customer-phone"
              value={form.phone}
              onChange={(e) => update('phone', e.target.value)}
              required
              inputMode="tel"
              maxLength={20}
              placeholder="10-digit mobile"
              className={inputClass}
              disabled={submitting}
            />
          </div>
          <div>
            <label htmlFor="customer-email" className={labelClass}>Email</label>
            <input
              id="customer-email"
              type="email"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              className={inputClass}
              disabled={submitting}
            />
          </div>
          <div>
            <label htmlFor="customer-credit-limit" className={labelClass}>Credit limit (₹)</label>
            <input
              id="customer-credit-limit"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={form.creditLimit}
              onChange={(e) => update('creditLimit', e.target.value)}
              placeholder={mode === 'create' ? 'Leave blank for the shop default' : ''}
              className={inputClass}
              disabled={submitting}
            />
          </div>
        </div>

        <div>
          <label htmlFor="customer-address" className={labelClass}>Address</label>
          <textarea
            id="customer-address"
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
            rows={2}
            className={inputClass}
            disabled={submitting}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="customer-city" className={labelClass}>City</label>
            <input
              id="customer-city"
              value={form.city}
              onChange={(e) => update('city', e.target.value)}
              maxLength={80}
              className={inputClass}
              disabled={submitting}
            />
          </div>
          <div>
            <label htmlFor="customer-state" className={labelClass}>State</label>
            <select
              id="customer-state"
              value={form.state}
              onChange={(e) => update('state', e.target.value)}
              className={inputClass}
              disabled={submitting}
            >
              <option value="">Not specified</option>
              {INDIAN_STATES.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-gray-500">Used to decide inter-state GST on this customer's bills.</p>
          </div>
        </div>

        <div>
          <label htmlFor="customer-notes" className={labelClass}>Notes</label>
          <textarea
            id="customer-notes"
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            rows={2}
            className={inputClass}
            disabled={submitting}
          />
        </div>

        {mode === 'edit' && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => update('isActive', e.target.checked)}
              disabled={submitting}
              className="h-4 w-4 rounded border-gray-300 text-[#8B5CF6] focus:ring-[#8B5CF6]"
            />
            Active customer (inactive customers cannot be billed on credit)
          </label>
        )}

        {formError && (
          <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
            {formError}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-[#8B5CF6] px-4 py-2 text-sm font-bold text-white shadow-lg shadow-purple-500/30 transition-colors hover:bg-[#7C3AED] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save customer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
