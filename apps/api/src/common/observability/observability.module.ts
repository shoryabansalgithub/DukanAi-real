import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { ObservabilityCollectorsService } from './observability-collectors.service';

/** Metrics scrape endpoint and its collectors (roadmap 7.6). Error tracking and the HTTP middleware are wired in main.ts. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [ObservabilityCollectorsService],
  exports: [ObservabilityCollectorsService],
})
export class ObservabilityModule {}
