'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Pause, Play, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { HeldCart } from '@/store/pos';
import { timeOnly } from './format';

// ---------------------------------------------------------------------------
// Hold prompt (F9)
// ---------------------------------------------------------------------------

interface HoldCartModalProps {
  isOpen: boolean;
  onClose: () => void;
  onHold: (label: string) => void;
  suggestedLabel: string;
}

export function HoldCartModal({ isOpen, onClose, onHold, suggestedLabel }: HoldCartModalProps) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (isOpen) setLabel('');
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Hold this cart" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onHold(label.trim() || suggestedLabel);
        }}
        className="space-y-4"
      >
        <div>
          <label htmlFor="hold-label" className="block text-sm font-medium text-gray-700 mb-1.5">
            Label (customer name, table, …)
          </label>
          <input
            id="hold-label"
            type="text"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={suggestedLabel}
            className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]"
          />
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button type="submit" className="flex-1 py-2.5 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold inline-flex items-center justify-center gap-1.5">
            <Pause size={16} /> Hold
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Held carts dropdown
// ---------------------------------------------------------------------------

interface HeldCartsMenuProps {
  carts: HeldCart[];
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}

export function HeldCartsMenu({ carts, onResume, onDelete }: HeldCartsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (carts.length === 0) setOpen(false);
  }, [carts.length]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={carts.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Pause size={14} className="text-[#8B5CF6]" />
        Held
        {carts.length > 0 && <span className="rounded-full bg-[#8B5CF6] text-white text-[10px] px-1.5 py-0.5 leading-none">{carts.length}</span>}
        <ChevronDown size={14} className="text-gray-400" />
      </button>
      {open && carts.length > 0 && (
        <ul role="listbox" aria-label="Held carts" className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-gray-100 bg-white shadow-xl overflow-hidden">
          {carts.map((cart) => (
            <li key={cart.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-50 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-gray-800 truncate" title={cart.label}>
                  {cart.label}
                </p>
                <p className="text-[11px] text-gray-500">
                  {cart.lines.length} {cart.lines.length === 1 ? 'item' : 'items'} · {timeOnly(cart.createdAt)}
                  {cart.customer ? ` · ${cart.customer.name}` : ''}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Resume ${cart.label}`}
                onClick={() => {
                  onResume(cart.id);
                  setOpen(false);
                }}
                className="p-1.5 rounded-lg text-green-600 hover:bg-green-50"
              >
                <Play size={15} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${cart.label}`}
                onClick={() => onDelete(cart.id)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
