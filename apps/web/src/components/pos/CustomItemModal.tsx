'use client';

import React, { useEffect, useRef, useState } from 'react';
import { PenLine } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { CUSTOM_ITEM_NAME_MAX, allowsDecimalQuantity, lineFromCustomItem, quantityStep, type CustomItemInput } from '@/store/pos';
import type { GstRate, ProductUnit } from '@/types';

interface CustomItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Returns an error message when the store rejected the line, else null. */
  onAdd: (input: CustomItemInput) => string | null;
}

const GST_OPTIONS: Array<{ value: GstRate; label: string }> = [
  { value: 'ZERO', label: '0%' },
  { value: 'FIVE', label: '5%' },
  { value: 'TWELVE', label: '12%' },
  { value: 'EIGHTEEN', label: '18%' },
  { value: 'TWENTYEIGHT', label: '28%' },
];

const UNIT_OPTIONS: ProductUnit[] = ['PCS', 'KG', 'GM', 'LTR', 'ML', 'BOX', 'PACK', 'DOZEN', 'BUNDLE'];

const fieldClass =
  'w-full bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

/**
 * Ad-hoc line entry (contract §2 `custom`): name, price, quantity, GST slab
 * (default 18%) and unit (default PCS). Validation mirrors the store's
 * `lineFromCustomItem`; the API re-validates and answers CUSTOM_ITEM_INVALID.
 */
export function CustomItemModal({ isOpen, onClose, onAdd }: CustomItemModalProps) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [gstRate, setGstRate] = useState<GstRate>('EIGHTEEN');
  const [unit, setUnit] = useState<ProductUnit>('PCS');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setName('');
    setPrice('');
    setQuantity('1');
    setGstRate('EIGHTEEN');
    setUnit('PCS');
    setError(null);
    const t = window.setTimeout(() => nameRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [isOpen]);

  const submit = () => {
    const input: CustomItemInput = {
      name: name.trim(),
      unitPrice: Number(price),
      quantity: Number(quantity),
      gstRate,
      unit,
    };
    if (quantity.trim() === '' || !Number.isFinite(input.quantity)) {
      setError('Enter a quantity');
      return;
    }
    const check = lineFromCustomItem(input);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    const rejected = onAdd(input);
    if (rejected) {
      setError(rejected);
      return;
    }
    onClose();
  };

  const decimals = allowsDecimalQuantity(unit);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Custom item" size="sm">
      <form
        data-testid="custom-item-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <p className="text-xs text-gray-500">
          For something not in the catalogue. Custom lines are priced as typed, never touch stock and carry no cess.
        </p>
        <div>
          <label htmlFor="custom-item-name" className="block text-xs font-bold text-gray-600 mb-1.5">
            Name
          </label>
          <input
            ref={nameRef}
            id="custom-item-name"
            data-testid="custom-item-name"
            type="text"
            value={name}
            maxLength={CUSTOM_ITEM_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Gift wrapping"
            autoComplete="off"
            className={fieldClass}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="custom-item-price" className="block text-xs font-bold text-gray-600 mb-1.5">
              Unit price (₹, before GST)
            </label>
            <input
              id="custom-item-price"
              data-testid="custom-item-price"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="custom-item-quantity" className="block text-xs font-bold text-gray-600 mb-1.5">
              Quantity
            </label>
            <input
              id="custom-item-quantity"
              data-testid="custom-item-quantity"
              type="number"
              inputMode={decimals ? 'decimal' : 'numeric'}
              min={0}
              step={quantityStep(unit)}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="custom-item-gst" className="block text-xs font-bold text-gray-600 mb-1.5">
              GST slab
            </label>
            <select
              id="custom-item-gst"
              data-testid="custom-item-gst"
              value={gstRate}
              onChange={(e) => setGstRate(e.target.value as GstRate)}
              className={fieldClass}
            >
              {GST_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="custom-item-unit" className="block text-xs font-bold text-gray-600 mb-1.5">
              Unit
            </label>
            <select
              id="custom-item-unit"
              data-testid="custom-item-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as ProductUnit)}
              className={fieldClass}
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <p role="alert" data-testid="custom-item-error" className="text-xs font-medium text-red-600">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="submit"
            data-testid="custom-item-submit"
            className="flex-1 py-2.5 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold inline-flex items-center justify-center gap-1.5"
          >
            <PenLine size={16} /> Add to cart
          </button>
        </div>
      </form>
    </Modal>
  );
}
