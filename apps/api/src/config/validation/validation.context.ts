import { Injectable } from '@nestjs/common';
import { AiConfig } from '../domains/ai.config';
import { AppConfig } from '../domains/app.config';
import { BullConfig } from '../domains/bull.config';
import { CacheConfig } from '../domains/cache.config';
import { CronConfig } from '../domains/cron.config';
import { DatabaseConfig } from '../domains/database.config';
import { EmailConfig } from '../domains/email.config';
import { JwtConfig } from '../domains/jwt.config';
import { LoggingConfig } from '../domains/logging.config';
import { MonitoringConfig } from '../domains/monitoring.config';
import { PrismaConfig } from '../domains/prisma.config';
import { RedisConfig } from '../domains/redis.config';
import { SecurityConfig } from '../domains/security.config';
import { StorageConfig } from '../domains/storage.config';

@Injectable()
export class ValidationContext {
  constructor(
    public readonly aiConfig: AiConfig,
    public readonly appConfig: AppConfig,
    public readonly bullConfig: BullConfig,
    public readonly cacheConfig: CacheConfig,
    public readonly cronConfig: CronConfig,
    public readonly databaseConfig: DatabaseConfig,
    public readonly emailConfig: EmailConfig,
    public readonly jwtConfig: JwtConfig,
    public readonly loggingConfig: LoggingConfig,
    public readonly monitoringConfig: MonitoringConfig,
    public readonly prismaConfig: PrismaConfig,
    public readonly redisConfig: RedisConfig,
    public readonly securityConfig: SecurityConfig,
    public readonly storageConfig: StorageConfig,
  ) {}
}
