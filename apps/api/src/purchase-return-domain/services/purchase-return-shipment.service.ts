import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DispatchShipmentDto } from '../dto/purchase-return.dto';

@Injectable()
export class PurchaseReturnShipmentService {
  private readonly logger = new Logger(PurchaseReturnShipmentService.name);

  async createShipment(tx: Prisma.TransactionClient, shopId: string, returnId: string, payload: DispatchShipmentDto) {
    this.logger.log(`Creating Return Shipment for ${returnId}`);
    return tx.purchaseReturnShipment.create({
      data: {
        shopId,
        purchaseReturnId: returnId,
        carrier: payload.carrier,
        trackingNumber: payload.trackingNumber,
        vehicleNumber: payload.vehicleNumber,
        status: 'DISPATCHED',
        dispatchDate: new Date(),
      }
    });
  }
}
