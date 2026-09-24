'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import type { CartLine, QuantityResult } from '@/store/pos';
import { allowsDecimalQuantity, quantityStep } from '@/store/pos';
import type { EngineTotals } from './engine';
import { gstLabel, money, qty } from './format';
import { useNumericField } from './useNumericField';

interface CartPanelProps {
  lines: CartLine[];
  totals: EngineTotals | null;
  /** productId → message, e.g. INSUFFICIENT_STOCK details from the server. */
  lineErrors: Record<string, string>;
  onSetQuantity: (productId: string, quantity: number) => QuantityResult;
  onIncrement: (productId: string) => QuantityResult;
  onDecrement: (productId: string) => QuantityResult;
  onSetDiscount: (productId: string, percent: number) => void;
  onRemove: (productId: string) => void;
  onClear: () => void;
}

export function CartPanel({
  lines,
  totals,
  lineErrors,
  onSetQuantity,
  onIncrement,
  onDecrement,
  onSetDiscount,
  onRemove,
  onClear,
}: CartPanelProps) {
  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-gray-400">
        <ShoppingCart size={40} className="opacity-25 mb-3" />
        <p className="text-sm font-medium">Cart is empty</p>
        <p className="text-xs mt-1">Scan a barcode or pick a product to start a sale.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 text-[11px] font-bold uppercase tracking-wider text-gray-500">
        <span>
          {lines.length} {lines.length === 1 ? 'item' : 'items'}
        </span>
        <button type="button" onClick={onClear} className="text-red-500 hover:text-red-600 normal-case tracking-normal font-bold">
          Clear cart
        </button>
      </div>
      <ul data-testid="cart-lines" className="divide-y divide-gray-50 max-h-[40vh] lg:max-h-[calc(100vh-560px)] min-h-[160px] overflow-y-auto">
        {lines.map((line) => (
          <CartRow
            key={line.productId}
            line={line}
            lineTotal={totals?.byProductId[line.productId]?.lineTotal ?? null}
            serverError={lineErrors[line.productId]}
            onSetQuantity={onSetQuantity}
            onIncrement={onIncrement}
            onDecrement={onDecrement}
            onSetDiscount={onSetDiscount}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </div>
  );
}

interface CartRowProps {
  line: CartLine;
  lineTotal: number | null;
  serverError?: string;
  onSetQuantity: (productId: string, quantity: number) => QuantityResult;
  onIncrement: (productId: string) => QuantityResult;
  onDecrement: (productId: string) => QuantityResult;
  onSetDiscount: (productId: string, percent: number) => void;
  onRemove: (productId: string) => void;
}

function CartRow({ line, lineTotal, serverError, onSetQuantity, onIncrement, onDecrement, onSetDiscount, onRemove }: CartRowProps) {
  const [qtyText, setQtyText] = useState(String(line.quantity));
  const [error, setError] = useState<string | null>(null);
  const commitDiscount = useCallback((value: number) => onSetDiscount(line.productId, value), [onSetDiscount, line.productId]);
  const discountField = useNumericField(line.discountPercent, commitDiscount);

  useEffect(() => {
    // Keep intermediate text such as "1." while the parsed value still matches the store.
    setQtyText((current) => (Number(current) === line.quantity ? current : String(line.quantity)));
    setError(null);
  }, [line.quantity]);

  const apply = (result: QuantityResult) => {
    setError(result.ok ? null : result.reason);
    return result.ok;
  };

  const commitQuantity = (text: string) => {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) {
      setError('Enter a quantity');
      return;
    }
    if (apply(onSetQuantity(line.productId, value))) setQtyText(String(value));
  };

  const decimals = allowsDecimalQuantity(line.unit);
  const highlighted = Boolean(serverError);

  return (
    <li
      data-testid="cart-line"
      data-line-id={line.lineId}
      data-custom={line.isCustom ? 'true' : 'false'}
      className={`px-4 py-3 ${highlighted ? 'bg-red-50/70' : ''}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-gray-800 truncate flex items-center gap-1.5" title={line.name}>
            <span className="truncate" data-testid="cart-line-name">
              {line.name}
            </span>
            {line.isCustom && (
              <span
                data-testid="cart-line-custom-badge"
                className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700"
                title="Custom item: priced as typed, no stock movement"
              >
                custom
              </span>
            )}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {money(line.unitPrice)} / {line.unit}
            {line.mrp > line.unitPrice ? <span className="ml-1 line-through">{money(line.mrp)}</span> : null}
            {line.sku ? <span className="ml-1">· {line.sku}</span> : null}
            {line.isCustom ? <span className="ml-1">· GST {gstLabel(line.gstRate)}</span> : null}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-[#8B5CF6]" data-testid="cart-line-total">
            {lineTotal === null ? '—' : money(lineTotal)}
          </p>
          <p className="text-[10px] text-gray-400">incl. tax</p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <div className="flex items-center rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
          <button
            type="button"
            aria-label={`Decrease quantity of ${line.name}`}
            onClick={() => apply(onDecrement(line.productId))}
            className="h-8 w-8 flex items-center justify-center text-gray-600 hover:bg-white hover:text-red-500 transition-colors"
          >
            <Minus size={14} />
          </button>
          <input
            type="number"
            inputMode={decimals ? 'decimal' : 'numeric'}
            min={0}
            step={quantityStep(line.unit)}
            value={qtyText}
            aria-label={`Quantity of ${line.name}`}
            aria-invalid={Boolean(error) || highlighted}
            onChange={(e) => {
              setQtyText(e.target.value);
              const value = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(value)) apply(onSetQuantity(line.productId, value));
            }}
            onBlur={(e) => commitQuantity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitQuantity(qtyText);
              }
            }}
            className="h-8 w-16 text-center text-sm font-bold text-gray-800 bg-white border-x border-gray-200 focus:outline-none focus:ring-1 focus:ring-[#8B5CF6]"
          />
          <button
            type="button"
            aria-label={`Increase quantity of ${line.name}`}
            onClick={() => apply(onIncrement(line.productId))}
            className="h-8 w-8 flex items-center justify-center text-gray-600 hover:bg-white hover:text-green-600 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        <span className="text-[11px] text-gray-400">{line.unit}</span>

        <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-500">
          <span>Disc</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={1}
            value={discountField.text}
            placeholder="0"
            aria-label={`Line discount percent for ${line.name}`}
            onChange={(e) => discountField.onChange(e.target.value)}
            className="h-8 w-14 rounded-lg border border-gray-200 bg-white px-2 text-right text-sm font-medium text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#8B5CF6]"
          />
          <span>%</span>
        </label>

        <button
          type="button"
          aria-label={`Remove ${line.name} from cart`}
          onClick={() => onRemove(line.productId)}
          className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {(error || serverError) && (
        <p role="alert" className="mt-1.5 text-[11px] font-medium text-red-600">
          {serverError ?? error}
        </p>
      )}
      {!error && !serverError && line.stockSnapshot !== null && line.quantity >= line.stockSnapshot && (
        <p className="mt-1.5 text-[11px] font-medium text-amber-600">All available stock ({qty(line.stockSnapshot, line.unit)}) is in the cart.</p>
      )}
    </li>
  );
}
