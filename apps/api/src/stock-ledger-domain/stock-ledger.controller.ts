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
    const balance = await this.ledgerCalc.calculateBalanceAt(shopId, inventoryItemId);
    return { inventoryItemId, calculatedBalance: balance };
  }

  @Get('integrity/:inventoryItemId')
  async checkIntegrity(@Param('inventoryItemId') inventoryItemId: string) {
    const shopId = this.tenantContext.getShopId();
    const isIntact = await this.ledgerIntegrity.verifyIntegrity(shopId, inventoryItemId);
    return { inventoryItemId, integrity: isIntact ? 'VERIFIED' : 'FAILED' };
  }
}
