'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Clock, Lock, RefreshCw, Unlock } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { shiftsApi } from '@/lib/api-client';
import type { Shift } from '@/types';
import { extractApiError } from './api-errors';
import { money, signedMoney, timeOnly } from './format';

interface ShiftBannerProps {
  onShiftChange?: (shift: Shift | null) => void;
  /** Bump to re-fetch the current shift (e.g. after a sale). */
  refreshToken?: number;
  className?: string;
}

const inputClass =
  'w-full bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

/**
 * "No open shift" / "Shift open" banner with open & close modals.
 * Reused by the POS page and the shifts page.
 */
export function ShiftBanner({ onShiftChange, refreshToken = 0, className = '' }: ShiftBannerProps) {
  const { toast } = useToast();
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openModal, setOpenModal] = useState(false);
  const [closeModal, setCloseModal] = useState(false);

  const publish = useCallback(
    (next: Shift | null) => {
      setShift(next);
      onShiftChange?.(next);
    },
    [onShiftChange],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      publish(await shiftsApi.current());
    } catch (err) {
      setError(extractApiError(err, 'Loading current shift (GET /shifts/current)').message);
    } finally {
      setLoading(false);
    }
  }, [publish]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  if (loading) {
    return (
      <div className={`rounded-xl border border-gray-100 bg-white px-4 py-3 ${className}`}>
        <SkeletonBox className="h-5 w-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm ${className}`}
      >
        <span className="flex items-center gap-2 text-red-700 font-medium">
          <AlertTriangle size={16} /> {error}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100"
        >
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {shift ? (
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm ${className}`}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-green-900">
            <span className="inline-flex items-center gap-2 font-bold">
              <Unlock size={16} className="text-green-600" /> Shift open
            </span>
            <span className="text-xs text-green-800">
              since {timeOnly(shift.openedAt)}
              {shift.openedBy?.name ? ` · ${shift.openedBy.name}` : ''}
            </span>
            <span className="text-xs">
              Opening <strong>{money(shift.openingCash)}</strong>
            </span>
            <span className="text-xs">
              Cash expected <strong>{money(shift.expectedCash)}</strong>
            </span>
            <span className="text-xs">
              Sales <strong>{money(shift.totalSales)}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setCloseModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-green-200 px-3 py-1.5 text-xs font-bold text-green-800 hover:bg-green-100 transition-colors"
          >
            <Lock size={14} /> Close shift
          </button>
        </div>
      ) : (
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm ${className}`}
        >
          <span className="inline-flex items-center gap-2 font-bold text-amber-900">
            <Clock size={16} className="text-amber-600" /> No open shift
            <span className="font-normal text-xs text-amber-800">— sales still record, but cash will not be tracked.</span>
          </span>
          <button
            type="button"
            onClick={() => setOpenModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors"
          >
            <Unlock size={14} /> Open shift
          </button>
        </div>
      )}

      <OpenShiftModal
        isOpen={openModal}
        onClose={() => setOpenModal(false)}
        onOpened={(next) => {
          publish(next);
          setOpenModal(false);
          toast('Shift opened', 'success');
        }}
        onAlreadyOpen={() => {
          setOpenModal(false);
          void load();
        }}
      />

      <CloseShiftModal
        isOpen={closeModal}
        shift={shift}
        onClose={() => setCloseModal(false)}
        onClosed={() => {
          publish(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Open shift
// ---------------------------------------------------------------------------

interface OpenShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpened: (shift: Shift) => void;
  onAlreadyOpen?: () => void;
}

export function OpenShiftModal({ isOpen, onClose, onOpened, onAlreadyOpen }: OpenShiftModalProps) {
  const [openingCash, setOpeningCash] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setOpeningCash('');
      setError(null);
    }
  }, [isOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(openingCash);
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Enter the cash in the drawer (0 or more).');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onOpened(await shiftsApi.open(amount));
    } catch (err) {
      const info = extractApiError(err, 'Opening shift (POST /shifts/open)');
      if (info.code === 'SHIFT_ALREADY_OPEN') {
        onAlreadyOpen?.();
      } else {
        setError(info.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Open shift" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="opening-cash" className="block text-sm font-medium text-gray-700 mb-1.5">
            Opening cash in drawer (₹)
          </label>
          <input
            id="opening-cash"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            autoFocus
            value={openingCash}
            onChange={(e) => setOpeningCash(e.target.value)}
            placeholder="0.00"
            className={inputClass}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 py-2.5 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-60 text-white font-bold"
          >
            {submitting ? 'Opening…' : 'Open shift'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Close shift
// ---------------------------------------------------------------------------

interface CloseShiftModalProps {
  isOpen: boolean;
  shift: Shift | null;
  onClose: () => void;
  onClosed: (closed: Shift) => void;
}

export function CloseShiftModal({ isOpen, shift, onClose, onClosed }: CloseShiftModalProps) {
  const [closingCash, setClosingCash] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Shift | null>(null);

  useEffect(() => {
    if (isOpen) {
      setClosingCash('');
      setNotes('');
      setError(null);
      setResult(null);
    }
  }, [isOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(closingCash);
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Enter the cash counted in the drawer (0 or more).');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const closed = await shiftsApi.close({ closingCash: amount, notes: notes.trim() || undefined });
      setResult(closed);
      onClosed(closed);
    } catch (err) {
      setError(extractApiError(err, 'Closing shift (POST /shifts/current/close)').message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={result ? 'Shift closed' : 'Close shift'} size="sm">
      {result ? (
        <div className="space-y-4">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Expected cash</dt>
              <dd className="font-bold text-gray-800">{money(result.expectedCash)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Counted cash</dt>
              <dd className="font-bold text-gray-800">{money(result.closingCash)}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-100 pt-2">
              <dt className="text-gray-500">Variance</dt>
              <dd
                className={`font-bold ${
                  (result.variance ?? 0) === 0 ? 'text-green-600' : (result.variance ?? 0) > 0 ? 'text-blue-600' : 'text-red-600'
                }`}
              >
                {signedMoney(result.variance)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Total sales</dt>
              <dd className="font-medium text-gray-800">{money(result.totalSales)}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold"
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {shift && (
            <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Opening cash</span>
                <span className="font-medium">{money(shift.openingCash)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Cash sales</span>
                <span className="font-medium">{money(shift.cashSales)}</span>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-1 mt-1">
                <span className="text-gray-600 font-medium">Expected in drawer</span>
                <span className="font-bold text-gray-900">{money(shift.expectedCash)}</span>
              </div>
            </div>
          )}
          <div>
            <label htmlFor="closing-cash" className="block text-sm font-medium text-gray-700 mb-1.5">
              Counted cash (₹)
            </label>
            <input
              id="closing-cash"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              autoFocus
              value={closingCash}
              onChange={(e) => setClosingCash(e.target.value)}
              placeholder="0.00"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="closing-notes" className="block text-sm font-medium text-gray-700 mb-1.5">
              Notes (optional)
            </label>
            <textarea
              id="closing-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-gray-900 hover:bg-black disabled:opacity-60 text-white font-bold"
            >
              {submitting ? 'Closing…' : 'Close shift'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
