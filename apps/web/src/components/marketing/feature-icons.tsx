import { Receipt, BookUser, Boxes, ScanLine, Wallet, type LucideIcon } from 'lucide-react';

/** One icon per feature page, keyed by path. */
export const FEATURE_ICONS: Record<string, LucideIcon> = {
  '/features/gst-billing': Receipt,
  '/features/udhar-khata': BookUser,
  '/features/inventory-management': Boxes,
  '/features/bill-scanner': ScanLine,
  '/features/cash-drawer-shifts': Wallet,
};
