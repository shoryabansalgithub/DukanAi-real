'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, CreditCard, Keyboard, Pause, PenLine } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { billingApi, mapSearchResult, productsApi, productToSearchResult, searchApi, shopApi } from '@/lib/api-client';
import type { CreateInvoiceRequest, InvoiceLineRequest } from '@/lib/api-client';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { useHotkeys } from '@/hooks/useHotkeys';
import { hydratePosStore, scopePosStoreToShop, usePosStore, type CartLine, type CustomItemInput } from '@/store/pos';
import type { CreateInvoiceResponse, GstRate, ProductUnit, SearchResult, Shift, ShopProfile } from '@/types';
import { ShiftBanner } from '@/components/pos/ShiftBanner';
import { ProductSearch, isSellable } from '@/components/pos/ProductSearch';
import { CartPanel } from '@/components/pos/CartPanel';
import { TotalsCard } from '@/components/pos/TotalsCard';
import { CustomerPicker } from '@/components/pos/CustomerPicker';
import { PaymentPanel, type SubmitError } from '@/components/pos/PaymentPanel';
import { ReceiptModal } from '@/components/pos/ReceiptModal';
import { HeldCartsMenu, HoldCartModal } from '@/components/pos/HeldCarts';
import { CustomItemModal } from '@/components/pos/CustomItemModal';
import { calculateCart, type PaymentSpec } from '@/components/pos/engine';
import { detailNumber, detailString, extractApiError } from '@/components/pos/api-errors';
import { isInterStateSupply } from '@/components/pos/indian-states';
import { money, qty } from '@/components/pos/format';

function BillingContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  // ---- Store ---------------------------------------------------------------
  const lines = usePosStore((s) => s.lines);
  const customer = usePosStore((s) => s.customer);
  const discount = usePosStore((s) => s.discount);
  const notes = usePosStore((s) => s.notes);
  const heldCarts = usePosStore((s) => s.heldCarts);
  const addProduct = usePosStore((s) => s.addProduct);
  const addCustomItem = usePosStore((s) => s.addCustomItem);
  const setQuantity = usePosStore((s) => s.setQuantity);
  const increment = usePosStore((s) => s.increment);
  const decrement = usePosStore((s) => s.decrement);
  const setLineDiscount = usePosStore((s) => s.setLineDiscount);
  const removeLine = usePosStore((s) => s.removeLine);
  const clearCart = usePosStore((s) => s.clearCart);
  const holdCart = usePosStore((s) => s.holdCart);
  const resumeHeldCart = usePosStore((s) => s.resumeHeldCart);
  const deleteHeldCart = usePosStore((s) => s.deleteHeldCart);
  const setCustomer = usePosStore((s) => s.setCustomer);
  const setDiscount = usePosStore((s) => s.setDiscount);
  const setNotes = usePosStore((s) => s.setNotes);
  const { ensure: ensureKey, rotate: rotateKey, consume: consumeKey } = useIdempotencyKey();

  // ---- Page state ----------------------------------------------------------
  const [shop, setShop] = useState<ShopProfile | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const [shift, setShift] = useState<Shift | null>(null);
  const [shiftRefresh, setShiftRefresh] = useState(0);
  const [gridRefresh, setGridRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [candidates, setCandidates] = useState<SearchResult[] | null>(null);
  const [receipt, setReceipt] = useState<CreateInvoiceResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});

  const searchRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const paramsHandledRef = useRef(false);

  const focusSearch = useCallback(() => {
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  // ---- Bootstrap: rehydrate cart, load shop, scope persistence by shop ---
  useEffect(() => {
    hydratePosStore();
    let cancelled = false;
    shopApi
      .me()
      .then((me) => {
        if (cancelled) return;
        setShop(me);
        scopePosStoreToShop(me.id);
      })
      .catch((err) => {
        if (!cancelled) setShopError(extractApiError(err, 'Loading shop (GET /shops/me)').message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Deep links from the dashboard / assistant (?product=ID, ?addItem=name&qty=N)
  useEffect(() => {
    if (paramsHandledRef.current) return;
    const productId = searchParams.get('product');
    const addItem = searchParams.get('addItem');
    if (!productId && !addItem) return;
    paramsHandledRef.current = true;
    const quantity = Math.max(1, Number(searchParams.get('qty')) || 1);
    const run = async () => {
      try {
        let product: SearchResult | undefined;
        if (productId) product = productToSearchResult(await productsApi.get(productId));
        else if (addItem) product = (await searchApi.search(addItem, { limit: 1 }))[0];
        if (!product) {
          toast(`Could not find "${addItem ?? productId}"`, 'warning');
        } else {
          const result = addProduct(product, quantity);
          if (result.ok) toast(`Added ${qty(quantity)} × ${product.name}`, 'success');
          else toast(result.reason, 'error');
        }
      } catch (err) {
        toast(extractApiError(err, 'Adding product from link').message, 'error');
      } finally {
        router.replace('/billing');
      }
    };
    void run();
  }, [searchParams, addProduct, router, toast]);

  // ---- Engine preview (no payment) ----------------------------------------
  const isInterState = isInterStateSupply(shop?.state, customer?.state);
  const preview = useMemo(() => calculateCart({ lines, discount, isInterState }), [lines, discount, isInterState]);
  const previewTotals = preview.ok ? preview.totals : null;
  const engineError = preview.ok ? null : preview.error;

  const cartQuantities = useMemo(() => {
    const map: Record<string, number> = {};
    lines.forEach((l) => {
      map[l.productId] = l.quantity;
    });
    return map;
  }, [lines]);

  // ---- Cart actions --------------------------------------------------------
  const handleAdd = useCallback(
    (product: SearchResult, quantity = 1) => {
      if (!isSellable(product)) {
        toast(`${product.name} is out of stock`, 'error');
        return;
      }
      const result = addProduct(product, quantity);
      if (!result.ok) {
        toast(result.reason, 'error');
        return;
      }
      setLineErrors((prev) => {
        if (!prev[product.id]) return prev;
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
      focusSearch();
    },
    [addProduct, toast, focusSearch],
  );

  const handleScan = useCallback(
    async (code: string) => {
      setQuery('');
      try {
        const product = await searchApi.barcode(code);
        handleAdd(product);
      } catch (err) {
        const info = extractApiError(err, `Barcode lookup ${code}`);
        if (info.code === 'BARCODE_NOT_FOUND' || info.status === 404) {
          toast(`No product with barcode ${code}`, 'warning');
        } else if (info.code === 'BARCODE_AMBIGUOUS') {
          const rows = Array.isArray(info.details?.candidates) ? (info.details?.candidates as unknown[]) : [];
          setCandidates(rows.map((row) => mapSearchResult((row ?? {}) as Record<string, unknown>)));
        } else {
          toast(info.message, 'error');
        }
      }
    },
    [handleAdd, toast],
  );

  useBarcodeScanner(handleScan, { enabled: !receipt && !paymentOpen && !holdOpen && !customOpen });

  const handleAddCustom = useCallback(
    (input: CustomItemInput): string | null => {
      const result = addCustomItem(input);
      if (!result.ok) return result.reason;
      toast(`Added ${qty(input.quantity)} × ${input.name} (custom)`, 'success');
      return null;
    },
    [addCustomItem, toast],
  );

  const openPayment = useCallback(() => {
    if (lines.length === 0) {
      toast('Add something to the cart first', 'warning');
      return;
    }
    if (!preview.ok) {
      toast(preview.error.message, 'error');
      return;
    }
    setSubmitError(null);
    setPaymentOpen(true);
  }, [lines.length, preview, toast]);

  const closePayment = useCallback(() => {
    if (submitting) return;
    setPaymentOpen(false);
    focusSearch();
  }, [submitting, focusSearch]);

  const handleHold = (label: string) => {
    const held = holdCart(label);
    setHoldOpen(false);
    if (held) toast(`Cart held as "${held.label}"`, 'info');
    focusSearch();
  };

  const handleResume = (id: string) => {
    if (resumeHeldCart(id)) toast('Cart resumed', 'info');
    setLineErrors({});
    focusSearch();
  };

  // ---- Submit --------------------------------------------------------------
  const handleSubmit = async (payment: PaymentSpec) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    const settled = calculateCart({ lines, discount, isInterState, payment });
    if (!settled.ok) {
      setSubmitError({ code: settled.error.code, message: settled.error.message, retryable: false });
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    const key = ensureKey();
    const body: CreateInvoiceRequest = {
      idempotencyKey: key,
      items: lines.map(toLineRequest),
      customerId: customer?.id,
      notes: notes.trim() || undefined,
      shiftId: shift?.id,
      payments: payment.tenders.map((t) => ({
        tender: t.type,
        amount: t.amount,
        tenderedAmount: t.tenderedAmount,
        reference: t.reference,
      })),
      udharAmount: payment.udharAmount && payment.udharAmount > 0 ? payment.udharAmount : undefined,
    };
    if (discount.value > 0) {
      body.discountType = discount.type;
      if (discount.type === 'PERCENTAGE') body.discountPercentage = discount.value;
      else body.discountAmount = discount.value;
      body.discountReason = discount.reason.trim() || undefined;
    }

    try {
      const result = await billingApi.createInvoice(body);
      consumeKey();
      setPaymentOpen(false);
      setLineErrors({});
      clearCart();
      setReceipt(result);
      setShiftRefresh((n) => n + 1);
      setGridRefresh((n) => n + 1);
      toast(`Invoice ${result.invoice.invoiceNumber} saved`, 'success');
    } catch (err) {
      const info = extractApiError(err, 'Creating invoice (POST /billing/invoice)');
      switch (info.code) {
        case 'INSUFFICIENT_STOCK': {
          const productId = detailString(info.details, 'productId');
          const productName = detailString(info.details, 'productName') ?? 'This product';
          const available = detailNumber(info.details, 'availableQty');
          const requested = detailNumber(info.details, 'requestedQty');
          const text = `${productName}: only ${available === null ? 'less' : qty(available)} available${requested === null ? '' : ` (asked for ${qty(requested)})`}`;
          if (productId) setLineErrors((prev) => ({ ...prev, [productId]: text }));
          setPaymentOpen(false);
          setGridRefresh((n) => n + 1);
          toast(text, 'error');
          break;
        }
        case 'CREDIT_LIMIT_EXCEEDED': {
          const limit = detailNumber(info.details, 'creditLimit');
          const balance = detailNumber(info.details, 'currentBalance');
          const projected = detailNumber(info.details, 'projectedBalance');
          setSubmitError({
            code: info.code,
            message: `Credit limit exceeded: limit ${money(limit)}, current balance ${money(balance)}, this sale would take it to ${money(projected)}. Reduce the credit portion or ask a manager.`,
            retryable: false,
            details: info.details,
          });
          break;
        }
        case 'IDEMPOTENCY_KEY_REUSED': {
          rotateKey();
          setSubmitError({
            code: info.code,
            message: 'This request key was already used for a different bill. A new key has been generated — press Retry to submit again.',
            retryable: true,
          });
          break;
        }
        case 'SHIFT_INVALID': {
          setShiftRefresh((n) => n + 1);
          setSubmitError({ code: info.code, message: `${info.message} The shift status has been refreshed; try again.`, retryable: true });
          break;
        }
        case 'CUSTOMER_REQUIRED': {
          setSubmitError({ code: info.code, message: 'A customer is required for credit sales. Close this panel and select one.', retryable: false });
          break;
        }
        case 'CUSTOM_ITEM_INVALID': {
          setSubmitError({
            code: info.code,
            message: `${info.message} Check the custom item's name, price, GST slab and unit, then try again.`,
            retryable: false,
            details: info.details,
          });
          break;
        }
        default: {
          if (info.isNetwork) {
            setSubmitError({
              code: null,
              message: `${info.message} Your cart and request key are kept, so retrying will not create a duplicate bill.`,
              retryable: true,
            });
          } else {
            setSubmitError({ code: info.code, message: info.message, retryable: false, details: info.details });
          }
        }
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleNewSale = () => {
    setReceipt(null);
    focusSearch();
  };

  // ---- Hotkeys -------------------------------------------------------------
  useHotkeys({
    F2: () => searchRef.current?.focus(),
    F4: () => {
      if (customerRef.current) customerRef.current.focus();
      else if (customer) toast(`Customer: ${customer.name}. Remove them to pick another.`, 'info');
    },
    F8: () => {
      if (!paymentOpen && !receipt) openPayment();
    },
    F9: () => {
      if (lines.length > 0 && !paymentOpen && !receipt) setHoldOpen(true);
    },
    F6: () => {
      if (!paymentOpen && !receipt && !holdOpen) setCustomOpen(true);
    },
    Escape: () => {
      if (paymentOpen) closePayment();
      if (holdOpen) setHoldOpen(false);
      if (customOpen) setCustomOpen(false);
      if (candidates) setCandidates(null);
      if (!paymentOpen && !holdOpen && !customOpen && !candidates && !receipt) focusSearch();
    },
  });

  const checkoutDisabled = lines.length === 0 || !preview.ok || submitting;

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Point of Sale</h1>
          <p className="text-sm text-gray-500 mt-1 flex items-center gap-1.5">
            <Keyboard size={14} className="text-gray-400" />
            <span>
              <kbd className="font-mono">F2</kbd> search · <kbd className="font-mono">F4</kbd> customer · <kbd className="font-mono">F8</kbd> pay ·{' '}
              <kbd className="font-mono">F6</kbd> custom item · <kbd className="font-mono">F9</kbd> hold · <kbd className="font-mono">Esc</kbd> close
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HeldCartsMenu carts={heldCarts} onResume={handleResume} onDelete={deleteHeldCart} />
          <button
            type="button"
            data-testid="pos-custom-item"
            onClick={() => setCustomOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50"
          >
            <PenLine size={14} /> Custom item <span className="text-gray-400 font-mono">F6</span>
          </button>
          <button
            type="button"
            onClick={() => setHoldOpen(true)}
            disabled={lines.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Pause size={14} /> Hold cart <span className="text-gray-400 font-mono">F9</span>
          </button>
        </div>
      </div>

      <ShiftBanner onShiftChange={setShift} refreshToken={shiftRefresh} />

      {shopError && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{shopError} GST is being split as intra-state until the shop profile loads.</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
        {/* Left: product search + grid */}
        <Card className="lg:col-span-3 p-0 overflow-hidden">
          <ProductSearch
            query={query}
            onQueryChange={setQuery}
            onAdd={handleAdd}
            inputRef={searchRef}
            cartQuantities={cartQuantities}
            refreshToken={gridRefresh}
          />
        </Card>

        {/* Right: customer, cart, totals, actions */}
        <Card className="lg:col-span-2 p-0 overflow-visible">
          <CustomerPicker customer={customer} onSelect={setCustomer} inputRef={customerRef} onDone={focusSearch} />
          <div className="border-t border-gray-100" />
          <CartPanel
            lines={lines}
            totals={previewTotals}
            lineErrors={lineErrors}
            onSetQuantity={setQuantity}
            onIncrement={increment}
            onDecrement={decrement}
            onSetDiscount={setLineDiscount}
            onRemove={(id) => {
              removeLine(id);
              setLineErrors((prev) => {
                if (!prev[id]) return prev;
                const next = { ...prev };
                delete next[id];
                return next;
              });
            }}
            onClear={() => {
              clearCart();
              setLineErrors({});
              focusSearch();
            }}
          />
          <div className="border-t border-gray-100" />
          <TotalsCard
            totals={previewTotals}
            engineError={engineError}
            discount={discount}
            onDiscountChange={setDiscount}
            isInterState={isInterState}
            shopState={shop?.state ?? null}
            customerState={customer?.state ?? null}
            notes={notes}
            onNotesChange={setNotes}
            hasLines={lines.length > 0}
          />
          <div className="p-4 border-t border-gray-100">
            <button
              type="button"
              data-testid="pos-charge"
              onClick={openPayment}
              disabled={checkoutDisabled}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:bg-purple-300 disabled:cursor-not-allowed py-3.5 text-white font-bold shadow-lg shadow-purple-500/30 transition-colors"
            >
              <CreditCard size={18} />
              Charge {previewTotals && lines.length > 0 && preview.ok ? money(previewTotals.finalTotal) : ''}
              <span className="ml-1 text-[11px] font-mono opacity-80">F8</span>
            </button>
            {!shift && lines.length > 0 && (
              <p className="mt-2 text-center text-[11px] text-amber-700">No open shift — cash from this sale will not be tracked in a drawer.</p>
            )}
          </div>
        </Card>
      </div>

      {/* Panels & modals */}
      {previewTotals && (
        <PaymentPanel
          isOpen={paymentOpen}
          onClose={closePayment}
          lines={lines}
          discount={discount}
          isInterState={isInterState}
          preview={previewTotals}
          customer={customer}
          isSubmitting={submitting}
          submitError={submitError}
          onSubmit={(payment) => void handleSubmit(payment)}
        />
      )}

      <HoldCartModal
        isOpen={holdOpen}
        onClose={() => {
          setHoldOpen(false);
          focusSearch();
        }}
        onHold={handleHold}
        suggestedLabel={customer?.name ?? `Cart ${heldCarts.length + 1}`}
      />

      <CustomItemModal
        isOpen={customOpen}
        onClose={() => {
          setCustomOpen(false);
          focusSearch();
        }}
        onAdd={handleAddCustom}
      />

      <ReceiptModal result={receipt} onNewSale={handleNewSale} />

      <Modal isOpen={candidates !== null} onClose={() => setCandidates(null)} title="Which product?" size="sm">
        <p className="text-sm text-gray-500 mb-3">This barcode matches more than one product. Pick the one being sold.</p>
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100 overflow-hidden">
          {(candidates ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  setCandidates(null);
                  handleAdd(c);
                }}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-purple-50"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-gray-800 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    {c.sku} · {qty(c.currentStock, c.unit)} in stock
                  </span>
                </span>
                <span className="text-sm font-bold text-gray-900 shrink-0">{money(c.sellingPrice)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

/**
 * Contract §2 item payload: product lines send `productId`, custom lines send
 * `custom` and no `productId` (exactly one of the two per item).
 */
function toLineRequest(line: CartLine): InvoiceLineRequest {
  const discountPercent = line.discountPercent > 0 ? line.discountPercent : undefined;
  if (line.isCustom) {
    return {
      custom: {
        name: line.name,
        unitPrice: line.unitPrice,
        gstRate: (line.gstRate || 'EIGHTEEN') as GstRate,
        unit: (line.unit || 'PCS') as ProductUnit,
      },
      quantity: line.quantity,
      discountPercent,
    };
  }
  return { productId: line.productId, quantity: line.quantity, discountPercent };
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading POS…</div>}>
      <BillingContent />
    </Suspense>
  );
}
