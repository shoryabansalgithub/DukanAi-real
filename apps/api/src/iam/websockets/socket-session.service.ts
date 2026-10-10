import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

@Injectable()
export class SocketSessionService {
  private readonly logger = new Logger(SocketSessionService.name);
  
  // Mapping of userId -> Set of connected Socket instances
  // Using Set allows a user to have multiple concurrent connections (e.g., mobile + desktop)
  private readonly activeSockets = new Map<string, Set<Socket>>();

  registerSocket(userId: string, socket: Socket) {
    if (!this.activeSockets.has(userId)) {
      this.activeSockets.set(userId, new Set());
    }
    this.activeSockets.get(userId)!.add(socket);
    this.logger.debug(`Socket ${socket.id} registered for user ${userId}. Total sockets: ${this.activeSockets.get(userId)!.size}`);

    socket.on('disconnect', () => {
      this.removeSocket(userId, socket);
    });
  }

  private removeSocket(userId: string, socket: Socket) {
    const userSockets = this.activeSockets.get(userId);
    if (userSockets) {
      userSockets.delete(socket);
      this.logger.debug(`Socket ${socket.id} removed for user ${userId}. Remaining sockets: ${userSockets.size}`);
      if (userSockets.size === 0) {
        this.activeSockets.delete(userId);
      }
    }
  }

  disconnectUser(userId: string, reason: string = 'Session revoked') {
    const userSockets = this.activeSockets.get(userId);
    if (userSockets) {
      this.logger.log(`Disconnecting ${userSockets.size} sockets for user ${userId}. Reason: ${reason}`);
      for (const socket of userSockets) {
        socket.emit('error', { message: reason, code: 'SESSION_REVOKED' });
        socket.disconnect(true);
      }
      this.activeSockets.delete(userId);
    }
  }

  disconnectShop(shopId: string, reason: string = 'Shop suspended/deleted') {
    // Iterate over all sockets to find those belonging to the shop
    let disconnectedCount = 0;
    for (const sockets of this.activeSockets.values()) {
      for (const socket of sockets) {
        if (socket.data?.shopId === shopId) {
          socket.emit('error', { message: reason, code: 'SHOP_REVOKED' });
          socket.disconnect(true);
          disconnectedCount++;
        }
      }
    }
    if (disconnectedCount > 0) {
      this.logger.log(`Disconnected ${disconnectedCount} sockets for shop ${shopId}. Reason: ${reason}`);
    }
  }
}
