'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReceiptPayload } from '@/types';
import { dateTime, gstLabel, money, qty, tenderLabel } from '@/components/pos/format';

// ---------------------------------------------------------------------------
// Print portal: the receipt is rendered into a body-level element so the
// print stylesheet can hide everything else without leaving blank pages.
// On screen it is a full-viewport preview with a toolbar (`print-hidden`).
// ---------------------------------------------------------------------------

export function ReceiptPrintPortal({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'receipt-print-root fixed inset-0 z-[70] overflow-auto bg-gray-100';
    document.body.appendChild(el);
    setHost(el);
    return () => {
      document.body.removeChild(el);
    };
  }, []);

  if (!host) return null;
  return createPortal(children, host);
}

// ---------------------------------------------------------------------------
// 80 mm thermal receipt
// ---------------------------------------------------------------------------

export function ReceiptView({ receipt }: { receipt: ReceiptPayload }) {
  const { shop, invoice, items, payments, gstSummary, totals } = receipt;
  const isReturn = invoice.type === 'SALES_RETURN';
  const isInterState = invoice.isInterState;
  const shopLine2 = [shop.city, shop.state, shop.pincode].filter(Boolean).join(', ');

  return (
    <div className="receipt-paper mx-auto my-6 w-[80mm] bg-white text-black shadow-md px-[4mm] py-[4mm] font-mono text-[11px] leading-[1.35]">
      {invoice.status === 'CANCELLED' && (
        <p className="text-center text-[13px] font-bold tracking-widest border-2 border-black py-1 mb-2">CANCELLED</p>
      )}
      <div className="text-center">
        <p className="text-[14px] font-bold uppercase leading-tight">{shop.name}</p>
        {shop.address && <p>{shop.address}</p>}
        {shopLine2 && <p>{shopLine2}</p>}
        {shop.phone && <p>Ph: {shop.phone}</p>}
        {shop.gstin && <p>GSTIN: {shop.gstin}</p>}
      </div>

      <Rule />
      <p className="text-center font-bold text-[12px]">{isReturn ? 'SALES RETURN' : 'TAX INVOICE'}</p>
      <Rule />

      <div className="grid grid-cols-[auto_1fr] gap-x-2">
        <span>No.</span>
        <span className="font-bold text-right">{invoice.invoiceNumber}</span>
        <span>Date</span>
        <span className="text-right">{dateTime(invoice.createdAt)}</span>
        {invoice.cashier?.name && (
          <>
            <span>Cashier</span>
            <span className="text-right truncate">{invoice.cashier.name}</span>
          </>
        )}
        <span>Customer</span>
        <span className="text-right truncate">{invoice.customer ? invoice.customer.name : 'Walk-in'}</span>
        {invoice.customer?.phone && (
          <>
            <span>Phone</span>
            <span className="text-right">{invoice.customer.phone}</span>
          </>
        )}
        {isReturn && invoice.originalInvoice && (
          <>
            <span>Against</span>
            <span className="text-right">{invoice.originalInvoice.invoiceNumber}</span>
          </>
        )}
      </div>

      <Rule />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className="font-bold">Item</th>
            <th className="font-bold text-right">Qty</th>
            <th className="font-bold text-right">Rate</th>
            <th className="font-bold text-right">Amt</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <React.Fragment key={item.id}>
              <tr>
                <td colSpan={4} className="pt-1 break-words">
                  {item.productName}
                  {item.isCustom ? <span className="text-[9px] uppercase text-gray-600"> · custom</span> : null}
                </td>
              </tr>
              <tr>
                <td className="text-[10px] text-gray-600">
                  {gstLabel(item.gstRate)} GST
                  {item.discountAmount > 0 ? ` · disc ${money(item.discountAmount)}` : ''}
                </td>
                <td className="text-right whitespace-nowrap">
                  {qty(item.quantity)}
                  <span className="text-[9px]"> {item.unit}</span>
                </td>
                <td className="text-right whitespace-nowrap">{money(item.sellingPrice)}</td>
                <td className="text-right whitespace-nowrap">{money(item.totalAmount)}</td>
              </tr>
            </React.Fragment>
          ))}
        </tbody>
      </table>

      <Rule />
      <div className="space-y-0.5">
        <TotalRow label="Subtotal" value={money(totals.subtotal)} />
        {totals.discount > 0 && <TotalRow label="Discount" value={`-${money(totals.discount)}`} />}
        <TotalRow label="Taxable" value={money(totals.taxable)} />
        {isInterState ? (
          <TotalRow label="IGST" value={money(invoice.igstAmount)} />
        ) : (
          <>
            <TotalRow label="CGST" value={money(invoice.cgstAmount)} />
            <TotalRow label="SGST" value={money(invoice.sgstAmount)} />
          </>
        )}
        {totals.roundOff !== 0 && <TotalRow label="Round off" value={`${totals.roundOff > 0 ? '+' : '-'}${money(Math.abs(totals.roundOff))}`} />}
        <div className="flex justify-between text-[13px] font-bold border-t border-dashed border-black pt-1 mt-1">
          <span>{isReturn ? 'REFUND' : 'TOTAL'}</span>
          <span>{money(totals.grandTotal)}</span>
        </div>
      </div>

      {gstSummary.length > 0 && (
        <>
          <Rule />
          <p className="font-bold">GST summary</p>
          <table className="w-full text-[10px]">
            <thead>
              <tr>
                <th className="text-left font-bold">Rate</th>
                <th className="text-right font-bold">Taxable</th>
                {isInterState ? (
                  <th className="text-right font-bold">IGST</th>
                ) : (
                  <>
                    <th className="text-right font-bold">CGST</th>
                    <th className="text-right font-bold">SGST</th>
                  </>
                )}
                {gstSummary.some((g) => g.cess > 0) && <th className="text-right font-bold">Cess</th>}
              </tr>
            </thead>
            <tbody>
              {gstSummary.map((g, i) => (
                <tr key={`${g.rate}-${i}`}>
                  <td>{gstLabel(g.rate)}</td>
                  <td className="text-right">{money(g.taxableAmount)}</td>
                  {isInterState ? (
                    <td className="text-right">{money(g.igst)}</td>
                  ) : (
                    <>
                      <td className="text-right">{money(g.cgst)}</td>
                      <td className="text-right">{money(g.sgst)}</td>
                    </>
                  )}
                  {gstSummary.some((x) => x.cess > 0) && <td className="text-right">{money(g.cess)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Rule />
      <div className="space-y-0.5">
        {payments.map((p, i) => (
          <TotalRow
            key={p.id || `${p.tender}-${i}`}
            label={`${tenderLabel(p.tender)}${p.reference ? ` (${p.reference})` : ''}`}
            value={money(p.tenderedAmount ?? p.amount)}
          />
        ))}
        {totals.udhar > 0 && <TotalRow label={isReturn ? 'Credit reversed' : 'On credit (udhar)'} value={money(totals.udhar)} />}
        {totals.change > 0 && <TotalRow label="Change" value={money(totals.change)} bold />}
      </div>

      {invoice.notes && (
        <>
          <Rule />
          <p className="text-[10px] break-words">Note: {invoice.notes}</p>
        </>
      )}

      <Rule />
      <p className="text-center">{isReturn ? `Returned against ${invoice.originalInvoice?.invoiceNumber ?? 'original invoice'}` : 'Thank you, visit again!'}</p>
      <p className="text-center text-[9px] text-gray-600 mt-1">Powered by DukaanAI</p>
    </div>
  );
}

function Rule() {
  return <div className="border-t border-dashed border-black my-1.5" />;
}

function TotalRow({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''}`}>
      <span className="truncate">{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
  );
}
