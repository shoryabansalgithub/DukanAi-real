import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';

@Injectable()
export class SocketThrottlerGuard extends ThrottlerGuard {
  async handleRequest(requestProps: any): Promise<boolean> {
    const { context, limit, ttl, throttler, blockDuration } = requestProps;

    if (context.getType() !== 'ws') {
      return true;
    }

    const client = context.switchToWs().getClient();
    const ip = client.handshake.address;
    
    // In v6, increment requires (tracker, ttl, limit, blockDuration, throttlerName)
    const { totalHits } = await this.storageService.increment(ip, ttl, limit, blockDuration, throttler.name);

    if (totalHits > limit) {
      throw new ThrottlerException('Too Many Requests');
    }

    return true;
  }
}
