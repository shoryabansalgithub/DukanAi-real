import { Environment } from '../config/domains/app.config';
import { PrismaConfig } from '../config/domains/prisma.config';
import { PrismaService } from './prisma.service';

describe('PrismaService.logLevelsFor (roadmap 5.8)', () => {
  const config = (logQueries: boolean) => Object.assign(new PrismaConfig(), { logQueries });

  it('production logs warnings and errors only, whatever the flag says', () => {
    expect(PrismaService.logLevelsFor({ nodeEnv: Environment.Production }, config(true))).toEqual(['warn', 'error']);
  });

  it('outside production PRISMA_LOG_QUERIES decides whether every query is logged', () => {
    expect(PrismaService.logLevelsFor({ nodeEnv: Environment.Test }, config(true))).toEqual(['query', 'info', 'warn', 'error']);
    expect(PrismaService.logLevelsFor({ nodeEnv: Environment.Test }, config(false))).toEqual(['info', 'warn', 'error']);
    expect(PrismaService.logLevelsFor({ nodeEnv: Environment.Development }, config(false))).not.toContain('query');
    expect(PrismaService.logLevelsFor({ nodeEnv: Environment.Development }, config(true))).toContain('query');
  });
});
