'use client';

import React from 'react';
import { Search, UserPlus } from 'lucide-react';
import type { FlowAction } from './flow';
import { ChoiceRow, SheetBody } from './ui';

export function ChooseStep({ dispatch }: { dispatch: React.Dispatch<FlowAction> }) {
  return (
    <SheetBody end>
      <p className="mb-3 text-[13px] leading-[18px] text-gray-500">Who is this bill for?</p>
      <div className="space-y-3">
        <ChoiceRow
          icon={<Search size={24} />}
          title="Old customer"
          hint="Search by name"
          onClick={() => dispatch({ type: 'open-search' })}
        />
        <ChoiceRow
          icon={<UserPlus size={24} />}
          title="New customer"
          hint="Name and phone"
          onClick={() => dispatch({ type: 'open-new' })}
        />
      </div>
    </SheetBody>
  );
}
