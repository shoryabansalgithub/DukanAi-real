import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomerRepository } from './repositories/customer.repository';
import { CustomerAuditService } from './services/customer-audit.service';
import { CustomerSearchService } from './services/customer-search.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerRepository, CustomerAuditService, CustomerSearchService],
  exports: [CustomersService, CustomerSearchService],
})
export class CustomersModule {}
