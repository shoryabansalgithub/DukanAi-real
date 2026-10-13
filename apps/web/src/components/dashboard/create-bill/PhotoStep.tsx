'use client';

import React, { useRef, useState } from 'react';
import { Camera, FolderOpen, Loader2 } from 'lucide-react';
import { blobToJpegDataUrl, newBillId } from '@/lib/smart-capture';
import type { PosCustomer } from '@/types';
import type { BillPhoto, FlowAction } from './flow';
import { CustomerChip, FieldError, PrimaryButton, SecondaryButton, SheetBody, SheetFooter } from './ui';

export function PhotoStep({
  customer,
  photo,
  dispatch,
}: {
  customer: PosCustomer;
  photo: BillPhoto | null;
  dispatch: React.Dispatch<FlowAction>;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const latestPick = useRef(0);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so picking the same file again still fires `change`.
    e.target.value = '';
    if (!file) return;
    const pick = ++latestPick.current;
    setPreparing(true);
    setError(null);
    try {
      const dataUrl = await blobToJpegDataUrl(file);
      if (pick === latestPick.current) dispatch({ type: 'photo', photo: { dataUrl, billId: newBillId() } });
    } catch {
      if (pick === latestPick.current) setError('This file is not an image the phone can read. Try a JPEG or PNG photo.');
    } finally {
      if (pick === latestPick.current) setPreparing(false);
    }
  };

  return (
    <>
      <SheetBody>
        <CustomerChip name={customer.name} phone={customer.phone} />
        <div aria-live="polite" className="mt-4">
          {preparing ? (
            <div className="grid h-48 place-items-center rounded-xl border border-dashed border-gray-200 bg-gray-50">
              <span className="flex items-center gap-2 text-[13px] leading-[18px] text-gray-500">
                <Loader2 aria-hidden size={18} className="animate-spin" />
                Preparing photo…
              </span>
            </div>
          ) : photo ? (
            <img
              src={photo.dataUrl}
              alt={`Bill photo for ${customer.name}`}
              className="max-h-[40dvh] w-full rounded-xl border border-gray-100 bg-gray-50 object-contain"
            />
          ) : (
            <div className="grid h-48 place-items-center rounded-xl border border-dashed border-gray-200 bg-gray-50 px-6 text-center">
              <p className="text-[13px] leading-[18px] text-gray-500">Take a photo of the paper bill, or pick one already on the phone.</p>
            </div>
          )}
          {error && <FieldError>{error}</FieldError>}
        </div>
      </SheetBody>
      <SheetFooter>
        {photo && !preparing ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <SecondaryButton onClick={() => cameraRef.current?.click()}>
                <Camera aria-hidden size={18} />
                Retake
              </SecondaryButton>
              <SecondaryButton onClick={() => filesRef.current?.click()}>
                <FolderOpen aria-hidden size={18} />
                Replace
              </SecondaryButton>
            </div>
            <PrimaryButton onClick={() => dispatch({ type: 'to-amount' })}>Continue</PrimaryButton>
          </>
        ) : (
          <>
            <PrimaryButton busy={preparing} onClick={() => cameraRef.current?.click()}>
              <span className="flex items-center gap-2">
                <Camera aria-hidden size={18} />
                Take photo
              </span>
            </PrimaryButton>
            <SecondaryButton onClick={() => filesRef.current?.click()}>
              <FolderOpen aria-hidden size={18} />
              Upload from files
            </SecondaryButton>
          </>
        )}
      </SheetFooter>
      {/* tailwindboss-ignore missing-micro-spec: hidden file inputs draw nothing; Take photo / Upload from files open them */}
      <input ref={cameraRef} name="bill-photo-camera" type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
      {/* tailwindboss-ignore missing-micro-spec: the same hidden input, for files */}
      <input ref={filesRef} name="bill-photo-file" type="file" accept="image/*" hidden onChange={onPick} />
    </>
  );
}
