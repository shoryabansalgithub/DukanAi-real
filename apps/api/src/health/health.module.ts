import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Liveness and readiness probes (roadmap 7.3). PrismaModule, RedisModule and LifecycleModule are global. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
