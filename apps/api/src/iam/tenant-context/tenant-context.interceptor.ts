import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';
import { TenantContext } from './tenant-context.interface';
import * as crypto from 'crypto';
import { SafeUserDto } from '../../users/dto/safe-user.dto';

interface RequestWithUserAndCorrelation {
  user?: SafeUserDto;
  headers: Record<string, string>;
  /** Settled by CorrelationIdMiddleware (sanitised); never read the raw header here. */
  correlationId?: string;
  requestId?: string;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContextService: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): any {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithUserAndCorrelation>();
    const user = request.user;
    
    // CorrelationIdMiddleware validated the client's values; the raw headers
    // must not win over them (they may be too long or unsafe to log).
    const correlationId = request.correlationId ?? crypto.randomUUID();
    const requestId = request.requestId ?? crypto.randomUUID();

    const tenantContext: TenantContext = {
      correlationId: correlationId as string,
      requestId: requestId as string,
      shopId: user?.shopId,
      userId: user?.id,
      role: user?.role,
      email: user?.email,
      shopStatus: user?.shopStatus,
      tokenVersion: user?.tokenVersion,
    };

    return new Observable((subscriber) => {
      this.tenantContextService.runWithContext(tenantContext, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
