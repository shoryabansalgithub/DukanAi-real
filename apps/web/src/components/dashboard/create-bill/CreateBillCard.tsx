'use client';

import { useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import { canUsePos } from '@/components/customers/permissions';
import { CreateBillSheet } from './CreateBillSheet';
import { PrimaryButton } from './ui';

/* micro-spec: Card / Create bill (phone only)
   role:      the dashboard's entry to the Create bill sheet; below md (768px, where the sidebar
              collapses) only: `md:hidden` takes it out of the layout at 768 and up
   form:      the app's Card (r 12, p 16, gray-100 edge, its own soft shadow); the 48px icon tile,
              its 24px glyph and the 16px bold title follow SummaryStatCard and QuickActionsCard;
              one line of 12px hint; the primary button runs the card's full width under them
   material:  Card's surface; tile accent @10% on the accent glyph, the dashboard's tile recipe
   depth:     Card's elevation, unchanged, so it sits level with the cards around it
   behaviour: the card is not pressable; only its button is
   cursor:    n/a (the button carries pointer)
   absent:    hover lift (`hoverable`): the card is not a link, a lift would promise one
*/
export function CreateBillCard() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  if (status !== 'loading' && !canUsePos(session?.user?.role)) return null;

  return (
    <>
      <Card className="md:hidden">
        <div className="flex items-center gap-4">
          <div aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#8B5CF6]/10 text-[#8B5CF6]">
            <ReceiptText size={24} />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-gray-800">Paper bill</h3>
            <p className="mt-0.5 text-xs text-gray-500">Photo of a paper bill, saved to the customer</p>
          </div>
        </div>
        <PrimaryButton className="mt-4" onClick={() => setOpen(true)}>
          Create bill
        </PrimaryButton>
      </Card>
      <CreateBillSheet open={open} onClosed={() => setOpen(false)} />
    </>
  );
}
