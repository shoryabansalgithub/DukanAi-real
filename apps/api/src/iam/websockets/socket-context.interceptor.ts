import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { Socket } from 'socket.io';

@Injectable()
export class SocketContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContextService: TenantContextService) {}

  // @ts-ignore: RxJS typings clash between monorepo packages
  intercept(context: ExecutionContext, next: CallHandler): any {
    if (context.getType() !== 'ws') {
      return next.handle();
    }

    const client = context.switchToWs().getClient<Socket>();
    
    // Ambient properties were securely populated by AuthenticatedIoAdapter
    const tenantContext = {
      shopId: client.data.shopId,
      userId: client.data.userId,
      role: client.data.role,
      correlationId: client.data.correlationId,
      requestId: `ws-req-${Date.now()}`
    };

    // runWithContext requires a Promise return, but interceptors use RxJS.
    // However, NestJS allows runWithContext's AsyncLocalStorage to persist across the RxJS observable chain
    // if we execute next.handle() inside the scope.
    let result: any;
    
    this.tenantContextService.runWithContext(tenantContext, () => {
      // Execute the actual handler within this ALS context
      result = next.handle();
    });

    return result! as any;
  }
}
