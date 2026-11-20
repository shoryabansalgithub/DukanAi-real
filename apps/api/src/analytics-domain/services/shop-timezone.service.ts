import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_BUSINESS_TIMEZONE, safeTimeZone } from '../../common/time/business-day';

/**
 * Resolves the IANA timezone every dashboard / report computation uses for
 * "today" and business-day ranges (ShopSettings.timezone, default Asia/Kolkata).
 */
@Injectable()
export class ShopTimezoneService {
  private readonly logger = new Logger(ShopTimezoneService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(shopId: string): Promise<string> {
    try {
      // ShopSettings is tenant-owned; inside a request the extension scopes it,
      // inside runAsSuperAdmin the explicit shopId does.
      const settings = await this.prisma.shopSettings.findUnique({
        where: { shopId },
        select: { timezone: true },
      });
      return safeTimeZone(settings?.timezone);
    } catch (error) {
      this.logger.warn(`Falling back to ${DEFAULT_BUSINESS_TIMEZONE} for shop ${shopId}: ${(error as Error).message}`);
      return DEFAULT_BUSINESS_TIMEZONE;
    }
  }
}
