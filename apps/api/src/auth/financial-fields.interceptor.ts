import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import type { SafeUserDto } from '../users/dto/safe-user.dto';
import { canSeeFinancials, withoutFinancialFields } from './financial-fields';

/**
 * Global (`APP_INTERCEPTOR`): every HTTP answer to a caller outside
 * FINANCE_ROLES (a CASHIER, a VIEWER, or nobody) leaves without the cost,
 * profit, valuation and payable fields (`isFinancialField`). Routes that are
 * financial as a whole carry `@Roles(...FINANCE_ROLES)` instead; this covers
 * the shared ones a cashier needs (products, search, invoices, batches,
 * stock), including fields a later change adds to them.
 */
@Injectable()
export class FinancialFieldsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): ReturnType<CallHandler['handle']> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest<{ user?: SafeUserDto }>().user;
    if (canSeeFinancials(user?.role)) return next.handle();
    const redact = map((body: unknown) => withoutFinancialFields(body));
    // Same two-rxjs-copies note as PagedListInterceptor: the operator is applied through `unknown`.
    return next.handle().pipe(redact as unknown as Parameters<ReturnType<CallHandler['handle']>['pipe']>[0]);
  }
}
