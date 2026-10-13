'use client';

import React, { useRef, useState } from 'react';
import { storageApi } from '@/lib/api-client';
import { dataUrlToBlob } from '@/lib/data-url';
import { extractApiError } from '@/components/pos/api-errors';
import type { PosCustomer } from '@/types';
import { parseRupees } from './amount';
import type { BillPhoto, FlowAction } from './flow';
import { CustomerChip, FieldError, PrimaryButton, SheetBody, SheetFooter, fieldClass, labelClass } from './ui';

export function AmountStep({
  customer,
  photo,
  amount,
  dispatch,
  onBusy,
}: {
  customer: PosCustomer;
  photo: BillPhoto;
  amount: string;
  dispatch: React.Dispatch<FlowAction>;
  /** Tells the sheet a save is in flight, so it is not closed under it. */
  onBusy: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const parsed = parseRupees(amount);
  const amountError = checked && !parsed.ok ? parsed.reason : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setChecked(true);
    if (!parsed.ok) {
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    onBusy(true);
    setSaveError(null);
    try {
      await storageApi.storeCapturedBill(customer.id, photo.billId, dataUrlToBlob(photo.dataUrl));
      dispatch({ type: 'saved', paise: parsed.paise });
    } catch (err) {
      const info = extractApiError(err, 'Saving the bill photo (POST /storage/bills)');
      // The bill id is minted per photo: a 409 on a retry means the lost answer had stored it.
      if (info.code === 'STORAGE_EVIDENCE_EXISTS') dispatch({ type: 'saved', paise: parsed.paise });
      else setSaveError(info.message);
    } finally {
      setSaving(false);
      onBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody>
        <CustomerChip name={customer.name} phone={customer.phone} />
        <label htmlFor="create-bill-amount" className={`${labelClass} mt-4`}>
          Bill amount
        </label>
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute inset-y-0 start-4 flex items-center text-base leading-6 text-gray-500">
            ₹
          </span>
          {/* tailwindboss-ignore missing-micro-spec: inherits Field / text (fieldClass, ./ui) */}
          <input
            id="create-bill-amount"
            ref={inputRef}
            data-autofocus
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => dispatch({ type: 'amount', amount: e.target.value })}
            onBlur={() => amount.trim() !== '' && setChecked(true)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? 'create-bill-amount-error' : undefined}
            className={`${fieldClass} ps-9 tabular-nums`}
          />
        </div>
        {amountError && <FieldError id="create-bill-amount-error">{amountError}</FieldError>}
        {saveError && <FieldError>{saveError}</FieldError>}
      </SheetBody>
      <SheetFooter>
        <PrimaryButton type="submit" busy={saving}>
          {saveError ? 'Try again' : 'Save bill'}
        </PrimaryButton>
      </SheetFooter>
    </form>
  );
}
