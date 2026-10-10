import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { MonitoringConfig } from '../../config/domains/monitoring.config';
import { StorageConfig } from '../../config/domains/storage.config';
import { UploadConfig } from '../../config/domains/upload.config';
import * as readiness from '../lifecycle/queue-readiness';
import { backupLastSuccessTimestampSeconds, buildInfo, dependencyUp, queueJobs, queuePaused, storageVolumeFreeBytes, storageVolumeSizeBytes } from './metrics';
import { COLLECTOR_BUDGET_MS, ObservabilityCollectorsService } from './observability-collectors.service';

/** The backup-status gauge (roadmap 9.4): one series per `<kind>.last-success` file, valued with its first line. */
describe('ObservabilityCollectorsService.refreshBackupStatus', () => {
  let dir: string;

  const service = (backupStatusDir?: string) =>
    new ObservabilityCollectorsService(
      {} as never,
      {} as never,
      {} as never,
      Object.assign(new MonitoringConfig(), { backupStatusDir }),
    );

  const series = async () => (await backupLastSuccessTimestampSeconds.get()).values.map((v) => ({ kind: v.labels.kind, value: v.value }));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-status-'));
    backupLastSuccessTimestampSeconds.reset();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads the UTC time on the first line of every <kind>.last-success file into the gauge', async () => {
    await fs.writeFile(path.join(dir, 'dump.last-success'), '2026-10-05T02:00:07Z\n/backups/dukaanai-20261005T020007Z.sql.gz\n');
    await fs.writeFile(path.join(dir, 'binlog.last-success'), '2026-10-05T17:35:00Z\nbinlog.000041\n');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    await service(dir).refreshBackupStatus();
    expect(await series()).toEqual(
      expect.arrayContaining([
        { kind: 'dump', value: Date.parse('2026-10-05T02:00:07Z') / 1000 },
        { kind: 'binlog', value: Date.parse('2026-10-05T17:35:00Z') / 1000 },
      ]),
    );
    expect(await series()).toHaveLength(2);
  });

  it('drops the series of a kind whose file disappeared and skips a file without a readable time', async () => {
    await fs.writeFile(path.join(dir, 'documents.last-success'), '2026-10-05T03:00:00Z\n');
    await fs.writeFile(path.join(dir, 'offsite.last-success'), 'not a time\n');
    await service(dir).refreshBackupStatus();
    expect(await series()).toEqual([{ kind: 'documents', value: Date.parse('2026-10-05T03:00:00Z') / 1000 }]);

    await fs.rm(path.join(dir, 'documents.last-success'));
    await service(dir).refreshBackupStatus();
    expect(await series()).toEqual([]);
  });

  it('leaves the gauge alone when no directory is configured or it cannot be read', async () => {
    await fs.writeFile(path.join(dir, 'dump.last-success'), '2026-10-05T02:00:07Z\n');
    await service(dir).refreshBackupStatus();
    expect(await series()).toHaveLength(1);

    await service(undefined).refreshBackupStatus();
    expect(await series()).toHaveLength(1);
    await service(path.join(dir, 'missing')).refreshBackupStatus();
    expect(await series()).toHaveLength(1);
  });
});

/** Roadmap 9.18: the scrape must answer during a dependency outage, and name the dependency. */
describe('ObservabilityCollectorsService.refresh under outages', () => {
  const never = () => new Promise<never>(() => undefined);
  const value = async (gauge: { get(): Promise<{ values: Array<{ labels: Record<string, string | number>; value: number }> }> }, labels: Record<string, string>) =>
    (await gauge.get()).values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value;

  function build(opts: { dbUp: boolean; redis: 'up' | 'hangs' }) {
    const prisma = { $queryRaw: jest.fn(() => (opts.dbUp ? Promise.resolve([{ notClean: 0, lastFinished: null }]) : Promise.reject(new Error("Can't reach database server")))) };
    const tenant = { runAsSuperAdmin: (fn: () => Promise<unknown>) => fn() };
    const redis = { ping: jest.fn(() => (opts.redis === 'up' ? Promise.resolve('PONG') : never())) };
    const service = new ObservabilityCollectorsService(prisma as never, tenant as never, {} as never, new MonitoringConfig(), redis as never);
    return { service, prisma };
  }

  beforeEach(() => {
    dependencyUp.reset();
    queueJobs.reset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers within its budget when Redis hangs: redis reported down, queue series dropped, database sources still read', async () => {
    const { service, prisma } = build({ dbUp: true, redis: 'hangs' });
    queueJobs.set({ queue: 'system-events', state: 'waiting' }, 3);
    const queues = jest.spyOn(service, 'refreshQueues');
    const started = Date.now();
    await service.refresh();
    expect(Date.now() - started).toBeLessThan(COLLECTOR_BUDGET_MS + 1500);
    expect(await value(dependencyUp, { dependency: 'redis' })).toBe(0);
    expect(await value(dependencyUp, { dependency: 'database' })).toBe(1);
    expect(queues).not.toHaveBeenCalled();
    expect((await queueJobs.get()).values).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4); // SELECT 1, outbox counts, oldest, reconciliation
  });

  it('bounds a source that never settles even when its dependency answered', async () => {
    const { service } = build({ dbUp: true, redis: 'up' });
    jest.spyOn(service, 'refreshQueues').mockReturnValue(never());
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const started = Date.now();
    await service.refresh();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(COLLECTOR_BUDGET_MS - 50);
    expect(took).toBeLessThan(COLLECTOR_BUDGET_MS + 1500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('queues metrics not refreshed within'));
  });

  it('skips the database sources while the database is down and reports it', async () => {
    const { service, prisma } = build({ dbUp: false, redis: 'up' });
    jest.spyOn(service, 'refreshQueues').mockResolvedValue(undefined);
    await service.refresh();
    expect(await value(dependencyUp, { dependency: 'database' })).toBe(0);
    expect(await value(dependencyUp, { dependency: 'redis' })).toBe(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // only the probe
  });

  it('measures the volumes under the storage root and the upload temp directory, also before they exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'volumes-'));
    try {
      const service = new ObservabilityCollectorsService(
        {} as never, {} as never, {} as never, new MonitoringConfig(), undefined,
        Object.assign(new StorageConfig(), { storageRoot: path.join(dir, 'storage', 'not-yet') }),
        Object.assign(new UploadConfig(), { tempDir: dir }),
      );
      await service.refreshStorageVolumes();
      const free = await value(storageVolumeFreeBytes, { volume: 'storage' });
      const size = await value(storageVolumeSizeBytes, { volume: 'uploads' });
      expect(free).toBeGreaterThan(0);
      expect(size).toBeGreaterThanOrEqual(free ?? 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/** The release the process runs (roadmap 9.21): one series, labelled with APP_RELEASE. */
describe('build_info', () => {
  const build = (appRelease?: string) => new ObservabilityCollectorsService({} as never, {} as never, {} as never, Object.assign(new MonitoringConfig(), { appRelease }));

  it('is 1 for the release the process runs, and "unknown" without one', async () => {
    build('v1.0.0-rc3');
    expect((await buildInfo.get()).values).toEqual([{ labels: { release: 'v1.0.0-rc3' }, value: 1 }]);
    build(undefined);
    expect((await buildInfo.get()).values).toEqual([{ labels: { release: 'unknown' }, value: 1 }]);
  });
});

/** Roadmap 9.22: a paused queue keeps its jobs in BullMQ's `paused` list; they count as waiting and the pause shows. */
describe('ObservabilityCollectorsService.refreshQueues', () => {
  const value = async (gauge: { get(): Promise<{ values: Array<{ labels: Record<string, string | number>; value: number }> }> }, labels: Record<string, string>) =>
    (await gauge.get()).values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value;

  beforeEach(() => {
    queueJobs.reset();
    queuePaused.reset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('counts the jobs of a paused queue as waiting and reports the pause', async () => {
    // What BullMQ 5 answers: asked for `waiting`, it also counts the `paused` list, under its own key.
    const paused = { name: 'system-events', getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, paused: 1200 })), isPaused: jest.fn(async () => true) };
    const running = { name: 'import-jobs', getJobCounts: jest.fn(async () => ({ waiting: 3, active: 1, delayed: 0, failed: 2, paused: 0 })), isPaused: jest.fn(async () => false) };
    jest.spyOn(readiness, 'queueInstances').mockReturnValue({ queues: [paused, running] as never, workers: [] });
    const service = new ObservabilityCollectorsService({} as never, {} as never, {} as never, new MonitoringConfig());

    await service.refreshQueues();

    expect(paused.getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'failed');
    expect(await value(queueJobs, { queue: 'system-events', state: 'waiting' })).toBe(1200);
    expect(await value(queuePaused, { queue: 'system-events' })).toBe(1);
    expect(await value(queueJobs, { queue: 'import-jobs', state: 'waiting' })).toBe(3);
    expect(await value(queueJobs, { queue: 'import-jobs', state: 'failed' })).toBe(2);
    expect(await value(queuePaused, { queue: 'import-jobs' })).toBe(0);
  });
});
