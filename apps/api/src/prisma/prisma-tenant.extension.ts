import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { isTenantModel, scopeTenantArgs } from './tenant-scope';

/**
 * Row-level tenant isolation for every model that carries `shopId` (see
 * tenant-scope.ts for the derivation and the global exceptions). Under a
 * tenant context every filter is narrowed to the caller's shop, every create
 * is bound to it, no update may move a row to another shop, and nested writes
 * into tenant models are scoped the same way. `runAsSuperAdmin` bypasses the
 * rules for system work that legitimately spans shops.
 */
export function tenantExtension(tenantContextService: TenantContextService) {
  return Prisma.defineExtension((client) => {
    return client.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (tenantContextService.isSuperAdminBypass()) {
              return query(args);
            }

            const shopId = currentShopId(tenantContextService);
            if (!shopId) {
              if (!isTenantModel(model)) return query(args);
              throw new InternalServerErrorException(`Missing tenant context for operation ${operation} on model ${model}`);
            }

            return query(scopeTenantArgs(model, operation, args, shopId) as typeof args);
          },
        },
      },
    });
  });
}

function currentShopId(tenantContextService: TenantContextService): string | undefined {
  try {
    return tenantContextService.getShopId();
  } catch {
    return undefined;
  }
}
