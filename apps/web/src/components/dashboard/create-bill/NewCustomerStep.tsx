'use client';

import React, { useRef, useState } from 'react';
import { posCustomersApi } from '@/lib/api-client';
import { detailString, extractApiError } from '@/components/pos/api-errors';
import type { PosCustomer } from '@/types';
import type { BillFlow, FlowAction } from './flow';
import { FieldError, PrimaryButton, SecondaryButton, SheetBody, SheetFooter, fieldClass, labelClass } from './ui';

type Problem =
  | { field: 'name' | 'phone'; message: string }
  | { field: 'form'; message: string; existing: PosCustomer | null };

export function NewCustomerStep({ draft, dispatch }: { draft: BillFlow['draft']; dispatch: React.Dispatch<FlowAction> }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const edit = (field: 'name' | 'phone', value: string) => {
    dispatch({ type: 'draft', field, value });
    if (problem && (problem.field === field || problem.field === 'form')) setProblem(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    // The POS rules, in the POS order: nothing else is checked here, the API decides the rest.
    if (!draft.name.trim()) {
      setProblem({ field: 'name', message: 'Name is required' });
      nameRef.current?.focus();
      return;
    }
    if (!draft.phone.trim()) {
      setProblem({ field: 'phone', message: 'Phone is required' });
      phoneRef.current?.focus();
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const customer = await posCustomersApi.create({ name: draft.name.trim(), phone: draft.phone.trim() });
      dispatch({ type: 'customer', customer, created: true });
    } catch (err) {
      const info = extractApiError(err, 'Creating customer (POST /customers)');
      const existingId = info.code === 'CUSTOMER_PHONE_IN_USE' ? detailString(info.details, 'customerId') : null;
      let existing: PosCustomer | null = null;
      if (existingId) {
        try {
          existing = await posCustomersApi.get(existingId);
        } catch {
          existing = null;
        }
      }
      setProblem({ field: 'form', message: info.message, existing });
    } finally {
      setSaving(false);
    }
  };

  const nameError = problem?.field === 'name' ? problem.message : null;
  const phoneError = problem?.field === 'phone' ? problem.message : null;

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody>
        <div className="space-y-4">
          <div>
            <label htmlFor="create-bill-name" className={labelClass}>
              Name
            </label>
            {/* tailwindboss-ignore missing-micro-spec: inherits Field / text (fieldClass, ./ui) */}
            <input
              id="create-bill-name"
              ref={nameRef}
              data-autofocus
              type="text"
              autoComplete="name"
              autoCapitalize="words"
              enterKeyHint="next"
              maxLength={100}
              value={draft.name}
              onChange={(e) => edit('name', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  phoneRef.current?.focus();
                }
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'create-bill-name-error' : undefined}
              className={fieldClass}
            />
            {nameError && <FieldError id="create-bill-name-error">{nameError}</FieldError>}
          </div>
          <div>
            <label htmlFor="create-bill-phone" className={labelClass}>
              Phone
            </label>
            {/* tailwindboss-ignore missing-micro-spec: inherits Field / text (fieldClass, ./ui) */}
            <input
              id="create-bill-phone"
              ref={phoneRef}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="done"
              maxLength={20}
              value={draft.phone}
              onChange={(e) => edit('phone', e.target.value)}
              aria-invalid={phoneError ? true : undefined}
              aria-describedby={phoneError ? 'create-bill-phone-error' : undefined}
              className={`${fieldClass} tabular-nums`}
            />
            {phoneError && <FieldError id="create-bill-phone-error">{phoneError}</FieldError>}
          </div>
          {problem?.field === 'form' && <FieldError>{problem.message}</FieldError>}
        </div>
      </SheetBody>
      <SheetFooter>
        {problem?.field === 'form' && problem.existing && (
          <SecondaryButton onClick={() => problem.existing && dispatch({ type: 'customer', customer: problem.existing, created: false })}>
            <span className="truncate">Use {problem.existing.name}</span>
          </SecondaryButton>
        )}
        <PrimaryButton type="submit" busy={saving}>
          Save customer
        </PrimaryButton>
      </SheetFooter>
    </form>
  );
}
