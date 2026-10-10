import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListInvoicesDto } from '../dto/list-invoices.dto';
import { BillingActor, INVOICE_INCLUDE } from '../billing.types';
import { BillingHelpers } from '../billing.helpers';
import { businessDayRange, businessDateString } from '../../common/time/business-day';

const SUMMARY_SELECT = {
  id: true,
  invoiceNumber: true,
  type: true,
  status: true,
  totalAmount: true,
  paidAmount: true,
  udharAmount: true,
  changeAmount: true,
  paymentMode: true,
  createdAt: true,
  originalId: true,
  customer: { select: { id: true, name: true } },
  cashier: { select: { id: true, name: true } },
  _count: { select: { items: true } },
} satisfies Prisma.InvoiceSelect;

/** Read side of the POS: history, detail and print payloads. */
@Injectable()
export class InvoiceQueryService {
  constructor(private readonly prisma: PrismaService, private readonly helpers: BillingHelpers) {}

  async list(query: ListInvoicesDto, actor: BillingActor) {
    const timeZone = await this.helpers.shopTimeZone(actor.shopId);
    const take = query.take ?? 25;
    const skip = query.skip ?? 0;

    const where: Prisma.InvoiceWhereInput = { shopId: actor.shopId, isDeleted: false };
    if (query.from || query.to) {
      const range = businessDayRange(query.from, query.to, timeZone);
      where.createdAt = { gte: range.start, lt: range.end };
    }
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.customerId) where.customerId = query.customerId;
    if (query.paymentMode) where.paymentMode = query.paymentMode;
    if (query.q) where.invoiceNumber = { contains: query.q.trim() };

    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, select: SUMMARY_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.invoice.count({ where }),
    ]);

    const saleIds = rows.filter((r) => r.type === 'SALE').map((r) => r.id);
    const returned = saleIds.length
      ? await this.prisma.invoice.groupBy({
          by: ['originalId'],
          where: { shopId: actor.shopId, originalId: { in: saleIds }, type: 'SALES_RETURN', status: 'COMPLETED', isDeleted: false },
          _sum: { totalAmount: true },
        })
      : [];
    const returnedMap = new Map(returned.map((r) => [r.originalId as string, r._sum.totalAmount ?? new Prisma.Decimal(0)]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        type: r.type,
        status: r.status,
        totalAmount: r.totalAmount,
        paidAmount: r.paidAmount,
        udharAmount: r.udharAmount,
        changeAmount: r.changeAmount,
        paymentMode: r.paymentMode,
        createdAt: r.createdAt,
        businessDate: businessDateString(r.createdAt, timeZone),
        customer: r.customer,
        cashier: r.cashier,
        itemCount: r._count.items,
        originalId: r.originalId,
        returnedAmount: returnedMap.get(r.id) ?? new Prisma.Decimal(0),
      })),
      total,
      skip,
      take,
    };
  }

  async get(invoiceId: string, actor: BillingActor) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, shopId: actor.shopId, isDeleted: false },
      include: {
        ...INVOICE_INCLUDE,
        shift: { select: { id: true, status: true, openedAt: true } },
        returnInvoices: { where: { isDeleted: false }, select: SUMMARY_SELECT, orderBy: { createdAt: 'asc' } },
        originalInvoice: { select: SUMMARY_SELECT },
      },
    });
    if (!invoice) throw new NotFoundException({ message: 'Invoice not found.', code: 'INVOICE_NOT_FOUND' });
    const timeZone = await this.helpers.shopTimeZone(actor.shopId);
    return {
      ...invoice,
      businessDate: businessDateString(invoice.createdAt, timeZone),
      returns: invoice.returnInvoices.map((r) => ({ ...r, itemCount: r._count.items })),
      returnInvoices: undefined,
    };
  }

  async receipt(invoiceId: string, actor: BillingActor) {
    const [invoice, shop] = await Promise.all([
      this.get(invoiceId, actor),
      this.prisma.shop.findUnique({
        where: { id: actor.shopId },
        select: { name: true, address: true, city: true, state: true, pincode: true, phone: true, email: true, settings: { select: { gstin: true, currency: true, timezone: true } } },
      }),
    ]);

    const gst = new Map<string, { rate: string; taxableAmount: Prisma.Decimal; cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal; cess: Prisma.Decimal }>();
    for (const item of invoice.items) {
      const taxes = item.cgstAmount.plus(item.sgstAmount).plus(item.igstAmount).plus(item.cessAmount);
      const taxable = item.taxableAmount.greaterThan(0) ? item.taxableAmount : item.totalAmount.minus(taxes);
      const row = gst.get(item.gstRate) ?? { rate: item.gstRate, taxableAmount: new Prisma.Decimal(0), cgst: new Prisma.Decimal(0), sgst: new Prisma.Decimal(0), igst: new Prisma.Decimal(0), cess: new Prisma.Decimal(0) };
      row.taxableAmount = row.taxableAmount.plus(taxable);
      row.cgst = row.cgst.plus(item.cgstAmount);
      row.sgst = row.sgst.plus(item.sgstAmount);
      row.igst = row.igst.plus(item.igstAmount);
      row.cess = row.cess.plus(item.cessAmount);
      gst.set(item.gstRate, row);
    }

    return {
      shop: {
        name: shop?.name ?? '',
        address: shop?.address ?? null,
        city: shop?.city ?? null,
        state: shop?.state ?? null,
        pincode: shop?.pincode ?? null,
        phone: shop?.phone ?? null,
        email: shop?.email ?? null,
        gstin: shop?.settings?.gstin ?? null,
        currency: shop?.settings?.currency ?? 'INR',
      },
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        type: invoice.type,
        status: invoice.status,
        createdAt: invoice.createdAt,
        businessDate: invoice.businessDate,
        cashier: invoice.cashier,
        customer: invoice.customer,
        paymentMode: invoice.paymentMode,
        isInterState: invoice.isInterState,
        notes: invoice.notes,
        original: invoice.originalInvoice ? { id: invoice.originalInvoice.id, invoiceNumber: invoice.originalInvoice.invoiceNumber } : null,
        cancelReason: invoice.cancelReason,
      },
      items: invoice.items.map((i) => ({
        id: i.id,
        productName: i.productName,
        productSku: i.productSku,
        quantity: i.quantity,
        unit: i.unit,
        sellingPrice: i.sellingPrice,
        mrp: i.mrp,
        discountPercent: i.discountPercent,
        discountAmount: i.discountAmount,
        taxableAmount: i.taxableAmount,
        gstRate: i.gstRate,
        cgstAmount: i.cgstAmount,
        sgstAmount: i.sgstAmount,
        igstAmount: i.igstAmount,
        cessAmount: i.cessAmount,
        totalAmount: i.totalAmount,
        returnedQuantity: i.returnedQuantity,
      })),
      payments: invoice.payments,
      gstSummary: Array.from(gst.values()).sort((a, b) => a.rate.localeCompare(b.rate)),
      totals: {
        subtotal: invoice.subtotal,
        discount: invoice.discountAmount,
        taxable: invoice.taxableAmount,
        cgst: invoice.cgstAmount,
        sgst: invoice.sgstAmount,
        igst: invoice.igstAmount,
        tax: invoice.taxAmount,
        roundOff: invoice.roundOffAmount,
        grandTotal: invoice.totalAmount,
        paid: invoice.paidAmount,
        change: invoice.changeAmount,
        udhar: invoice.udharAmount,
      },
    };
  }
}
