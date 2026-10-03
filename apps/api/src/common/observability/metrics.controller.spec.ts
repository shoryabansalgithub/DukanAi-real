import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MonitoringConfig } from '../../config/domains/monitoring.config';
import { MetricsController } from './metrics.controller';
import { ObservabilityCollectorsService } from './observability-collectors.service';

const TOKEN = 'a-scrape-token-of-sufficient-length';

function controller(overrides: Partial<Record<keyof MonitoringConfig, unknown>> = {}) {
  const collectors = { refresh: jest.fn().mockResolvedValue(undefined) };
  const config = Object.assign(new MonitoringConfig(), overrides);
  return { controller: new MetricsController(config, collectors as unknown as ObservabilityCollectorsService), collectors };
}

describe('MetricsController (roadmap 7.6)', () => {
  it('answers 404 when metrics are disabled', async () => {
    const { controller: c, collectors } = controller({ metricsEnabled: false });
    await expect(c.scrape(undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(collectors.refresh).not.toHaveBeenCalled();
  });

  it('refreshes the gauges and renders the registry when no token is configured', async () => {
    const { controller: c, collectors } = controller();
    const text = await c.scrape(undefined);
    expect(collectors.refresh).toHaveBeenCalledTimes(1);
    expect(text).toContain('# TYPE http_requests_total counter');
  });

  it.each([
    ['no header', undefined],
    ['a wrong token', `Bearer ${TOKEN}x`],
    ['a token of the right length', `Bearer ${TOKEN.replace(/a/, 'b')}`],
    ['the token in another scheme', `Basic ${TOKEN}`],
  ])('answers 401 with %s when METRICS_TOKEN is set', async (_label, header) => {
    const { controller: c, collectors } = controller({ metricsToken: TOKEN });
    await expect(c.scrape(header)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(collectors.refresh).not.toHaveBeenCalled();
  });

  it('accepts the configured bearer token', async () => {
    const { controller: c } = controller({ metricsToken: TOKEN });
    await expect(c.scrape(`Bearer ${TOKEN}`)).resolves.toContain('http_requests_total');
  });
});
