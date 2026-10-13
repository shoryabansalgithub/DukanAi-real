import { Global, Module } from '@nestjs/common';
import { GracefulShutdownService } from './graceful-shutdown.service';

/** Shutdown ordering and the draining flag the readiness probe reads (roadmap 7.3). */
@Global()
@Module({
  providers: [GracefulShutdownService],
  exports: [GracefulShutdownService],
})
export class LifecycleModule {}
