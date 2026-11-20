import { Controller, Get, Param } from '@nestjs/common';
import { LedgerCalculationService } from './services/ledger-calculation.service';
import { LedgerIntegrityService } from './services/ledger-integrity.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';

@Controller('stock-ledger')
export class StockLedgerController {
  constructor(
    private readonly ledgerCalc: LedgerCalculationService,
    private readonly ledgerIntegrity: LedgerIntegrityService,
    private readonly tenantContext: TenantContextService
  ) {}

  @Get('balance/:inventoryItemId')
  async getCalculatedBalance(@Param('inventoryItemId') inventoryItemId: string) {
    const shopId = this.tenantContext.getShopId();
    await this.ledgerIntegrity.requireItem(shopId, inventoryItemId);
    const balance = await this.ledgerCalc.calculateBalanceAt(shopId, inventoryItemId);
    return { inventoryItemId, calculatedBalance: balance };
  }

  @Get('integrity/:inventoryItemId')
  async checkIntegrity(@Param('inventoryItemId') inventoryItemId: string) {
    const shopId = this.tenantContext.getShopId();
    const report = await this.ledgerIntegrity.verifyIntegrity(shopId, inventoryItemId);
    return { inventoryItemId, integrity: report.intact ? 'VERIFIED' : 'FAILED', ledgerBalance: report.ledgerBalance, cachedBalance: report.cachedBalance };
  }
}
