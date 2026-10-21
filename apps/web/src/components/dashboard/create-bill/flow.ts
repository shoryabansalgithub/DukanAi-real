import type { PosCustomer } from '@/types';

export type StepName = 'choose' | 'search' | 'new' | 'photo' | 'amount' | 'saved';

export interface BillPhoto {
  dataUrl: string;
  /** Minted once per picked photo, so a retried save of the same photo converges on one stored file. */
  billId: string;
}

export interface BillFlow {
  /** Navigation history; the last entry is the visible step. Back pops. */
  stack: StepName[];
  customer: PosCustomer | null;
  /** The old-customer search text; carried into the new-customer name on "not found". */
  query: string;
  draft: { name: string; phone: string };
  photo: BillPhoto | null;
  /** What the user typed; parsed by `parseRupees` on save. */
  amount: string;
  savedPaise: number | null;
}

export type FlowAction =
  | { type: 'open-search' }
  | { type: 'open-new'; name?: string }
  | { type: 'query'; query: string }
  | { type: 'draft'; field: 'name' | 'phone'; value: string }
  | { type: 'customer'; customer: PosCustomer; created: boolean }
  | { type: 'photo'; photo: BillPhoto | null }
  | { type: 'to-amount' }
  | { type: 'amount'; amount: string }
  | { type: 'saved'; paise: number }
  | { type: 'back' }
  | { type: 'reset' };

export const STEP_TITLES: Record<StepName, string> = {
  choose: 'Create bill',
  search: 'Old customer',
  new: 'New customer',
  photo: 'Bill photo',
  amount: 'Amount',
  saved: 'Bill saved',
};

const CUSTOMER_STEPS: ReadonlySet<StepName> = new Set(['choose', 'search', 'new']);

export const initialFlow: BillFlow = {
  stack: ['choose'],
  customer: null,
  query: '',
  draft: { name: '', phone: '' },
  photo: null,
  amount: '',
  savedPaise: null,
};

export function currentStep(state: BillFlow): StepName {
  return state.stack[state.stack.length - 1];
}

export function flowReducer(state: BillFlow, action: FlowAction): BillFlow {
  const top = currentStep(state);
  switch (action.type) {
    case 'open-search':
      return top === 'choose' ? { ...state, stack: [...state.stack, 'search'] } : state;
    case 'open-new':
      if (top !== 'choose' && top !== 'search') return state;
      return {
        ...state,
        stack: [...state.stack, 'new'],
        draft: action.name === undefined ? state.draft : { ...state.draft, name: action.name },
      };
    case 'query':
      return { ...state, query: action.query };
    case 'draft':
      return { ...state, draft: { ...state.draft, [action.field]: action.value } };
    case 'customer': {
      if (!CUSTOMER_STEPS.has(top)) return state;
      // A created customer exists now: Back must not reopen the form that would create it twice.
      const base = action.created && top === 'new' ? state.stack.slice(0, -1) : state.stack;
      return { ...state, customer: action.customer, stack: [...base, 'photo'] };
    }
    case 'photo':
      return { ...state, photo: action.photo };
    case 'to-amount':
      return top === 'photo' && state.photo ? { ...state, stack: [...state.stack, 'amount'] } : state;
    case 'amount':
      return { ...state, amount: action.amount };
    case 'saved':
      return top === 'amount' ? { ...state, stack: ['saved'], savedPaise: action.paise } : state;
    case 'back': {
      if (state.stack.length <= 1 || top === 'saved') return state;
      const stack = state.stack.slice(0, -1);
      const landed = stack[stack.length - 1];
      return { ...state, stack, customer: CUSTOMER_STEPS.has(landed) ? null : state.customer };
    }
    case 'reset':
      return initialFlow;
  }
}
