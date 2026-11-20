import { Module, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { CorrelationContextService } from './correlation-context.service';
import { CorrelationIdMiddleware } from '../middleware/correlation-id.middleware';
import { NoStoreMiddleware } from '../middleware/no-store.middleware';

@Global()
@Module({
  providers: [CorrelationContextService],
  exports: [CorrelationContextService],
})
export class CorrelationModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, NoStoreMiddleware).forRoutes('*');
  }
}
