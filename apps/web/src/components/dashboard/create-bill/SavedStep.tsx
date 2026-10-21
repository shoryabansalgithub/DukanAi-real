'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import type { PosCustomer } from '@/types';
import { formatPaise } from './amount';
import type { BillPhoto } from './flow';
import { PrimaryButton, SecondaryButton, SheetBody, SheetFooter, textButtonClass } from './ui';

export function SavedStep({
  customer,
  photo,
  paise,
  onDone,
  onAnother,
}: {
  customer: PosCustomer;
  photo: BillPhoto;
  paise: number;
  onDone: () => void;
  onAnother: () => void;
}) {
  return (
    <>
      <SheetBody>
        <div className="flex items-start gap-4 pt-2">
          <img src={photo.dataUrl} alt="" className="h-20 w-16 shrink-0 rounded-lg border border-gray-100 bg-gray-50 object-cover" />
          <div className="min-w-0">
            <p className="flex items-start gap-2 text-[15px] font-bold leading-5 text-gray-800">
              <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-green-600 text-[#fff]">
                <Check size={14} strokeWidth={3} />
              </span>
              <span className="min-w-0">Bill photo saved for {customer.name}</span>
            </p>
            <p className="mt-2 text-[13px] leading-[18px] text-gray-700">
              Amount <span className="font-bold tabular-nums">{formatPaise(paise)}</span> is not recorded yet.
            </p>
          </div>
        </div>
        <Link href={`/customers/${encodeURIComponent(customer.id)}`} onClick={onDone} className={`${textButtonClass} mt-3`}>
          Open {customer.name}
        </Link>
      </SheetBody>
      <SheetFooter>
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
        <SecondaryButton onClick={onAnother}>Create another</SecondaryButton>
      </SheetFooter>
    </>
  );
}
