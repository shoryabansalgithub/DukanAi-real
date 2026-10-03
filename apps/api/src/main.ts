import { writeSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CorrelationLogger } from './common/logger/correlation.logger';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import helmet from 'helmet';
import { AuthenticatedIoAdapter } from './iam/websockets/authenticated-io.adapter';
import { AppConfig, Environment } from './config/domains/app.config';
import { applyTrustProxy } from './common/http/trust-proxy';
import { waitForQueueConnections } from './common/lifecycle/queue-readiness';
import { LoggingConfig } from './config/domains/logging.config';
import { MonitoringConfig } from './config/domains/monitoring.config';
import { ErrorTracking } from './common/observability/error-tracking';
import { httpMetricsMiddleware } from './common/observability/http-metrics.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Reject instead of aborting the process, so the catch below can report why.
    abortOnError: false,
  });
  
  // 1. Global Logger Binding: JSON lines with the correlation id, at the
  //    configured level (LOG_LEVEL; production prints at most "log", roadmap 7.6).
  const correlationLogger = new CorrelationLogger('', { logLevels: app.get(LoggingConfig).levels });
  app.useLogger(correlationLogger);

  const appConfig = app.get(AppConfig);
  const monitoringConfig = app.get(MonitoringConfig);

  // Error tracking (roadmap 7.6): a no-op until SENTRY_DSN is set.
  ErrorTracking.init(monitoringConfig, appConfig.nodeEnv);

  // WebSocket Authentication Adapter
  app.useWebSocketAdapter(new AuthenticatedIoAdapter(app));
  
  const logger = new Logger('Bootstrap');

  // Global API prefix
  app.setGlobalPrefix('api');

  // Graceful shutdown (roadmap 7.3): a signal runs the shutdown hooks
  // (GracefulShutdownService orders them) and then exits 0 on a clean close,
  // instead of re-raising the signal (exit 143, which orchestrators log as a
  // failed stop); an error during shutdown still exits 1.
  app.enableShutdownHooks(undefined, { useProcessExit: true });

  // Helmet Security
  app.use(helmet());

  // Request metrics (roadmap 7.6): every answer, guard rejections included.
  app.use(httpMetricsMiddleware);

  // Reverse proxies: decides what req.ip is (rate limiting, login audit rows).
  applyTrustProxy(app, appConfig.trustProxy, logger);

  // Strict CORS Lockdown
  const frontendUrl = appConfig.frontendUrl;
  app.enableCors({
    origin: frontendUrl.split(',').map((s: string) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
    // Paged lists describe their page in these headers (roadmap 5.6); a browser client may read them.
    exposedHeaders: ['X-Total-Count', 'X-Page-Skip', 'X-Page-Take', 'x-correlation-id'],
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global Exception Filter — consistent JSON error envelope with correlationId
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Swagger (Disabled in Production)
  if (appConfig.nodeEnv !== Environment.Production) {
    const config = new DocumentBuilder()
      .setTitle('DukaanAI API')
      .setDescription('The DukaanAI API documentation')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Deployment (roadmap 7.3): listen only once every BullMQ connection is
  // open (bounded), so a passing probe means the instance serves and consumes;
  // keep idle connections longer than the proxy in front does.
  await app.init();
  await waitForQueueConnections(app, { timeoutMs: appConfig.queueReadyTimeoutMs, logger });
  const server = app.getHttpServer() as import('http').Server;
  server.keepAliveTimeout = appConfig.httpKeepAliveTimeoutMs;
  server.headersTimeout = appConfig.httpKeepAliveTimeoutMs + 1_000;

  const port = appConfig.port;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port} (readiness: /api/health/ready)`);
  logger.log(
    `Logging at level ${app.get(LoggingConfig).logLevel}; metrics ${
      monitoringConfig.metricsEnabled
        ? `at GET /api/metrics (${monitoringConfig.metricsToken ? 'bearer token required' : 'no token: keep the port off the public internet'})`
        : 'disabled (METRICS_ENABLED=false)'
    }`,
  );
}
bootstrap().catch(async (error) => {
  const msg = `\n\n[Bootstrap FATAL]: ${error?.stack || error?.message || error}\n\n`;
  writeSync(2, msg);
  ErrorTracking.capture(error, { kind: 'startup' });
  await ErrorTracking.flush();
  process.exit(1);
});
