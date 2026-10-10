import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { UseInterceptors, UseGuards, UsePipes } from '@nestjs/common';
import { SocketContextInterceptor } from '../iam/websockets/socket-context.interceptor';
import { SocketRolesGuard } from '../iam/websockets/socket-roles.guard';
import { SocketThrottlerGuard } from '../iam/websockets/socket-throttler.guard';
import { SocketValidationPipe } from '../iam/websockets/socket-validation.pipe';

@WebSocketGateway({
  namespace: '/inventory',
})
@UseInterceptors(SocketContextInterceptor)
@UseGuards(SocketThrottlerGuard, SocketRolesGuard)
@UsePipes(new SocketValidationPipe())
@Injectable()
export class InventoryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(InventoryGateway.name);

  @WebSocketServer() server: Server;

  constructor(
    private readonly tenantContext: TenantContextService,
  ) {}

  async handleConnection(client: Socket) {
    // Authentication, authorization, and room-joining are entirely handled
    // by the AuthenticatedIoAdapter.
    // The Gateway simply observes the connection.
    const { userId, shopId } = client.data;
    this.logger.debug(`Client ${client.id} (user: ${userId}) joined inventory:${shopId}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client ${client.id} disconnected`);
  }

  broadcastStockUpdate(
    updates: Array<{ productId: string; newStock: number }>,
  ) {
    const shopId = this.tenantContext.getShopId();
    this.server.to(`tenant:${shopId}`).emit('stockUpdated', {
      updates,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLowStockAlert(
    alert: { productId: string; productName: string; currentStock: number },
  ) {
    const shopId = this.tenantContext.getShopId();
    this.server.to(`tenant:${shopId}`).emit('lowStockAlert', alert);
  }
}
