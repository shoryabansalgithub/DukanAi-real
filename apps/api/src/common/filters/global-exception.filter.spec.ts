import { ArgumentsHost, HttpStatus, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorTracking } from '../observability/error-tracking';
import { GlobalExceptionFilter } from './global-exception.filter';

function host(request: Record<string, unknown>) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
  const args = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as unknown as ArgumentsHost;
  return { args, response };
}

const request = { correlationId: 'corr-1', method: 'PATCH', baseUrl: '', route: { path: '/api/products/:id' } };

describe('GlobalExceptionFilter error tracking (roadmap 7.6)', () => {
  const filter = new GlobalExceptionFilter();
  let capture: jest.SpyInstance;

  beforeEach(() => {
    capture = jest.spyOn(ErrorTracking, 'capture').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('hands an unhandled error to error tracking with the request context and keeps the envelope', () => {
    const { args, response } = host(request);
    filter.catch(new Error('kaboom'), args);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'Internal server error', correlationId: 'corr-1' }));
    expect(capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ kind: 'unhandled', correlationId: 'corr-1', route: '/api/products/:id', method: 'PATCH', statusCode: 500 }),
    );
  });

  it('tracks a deliberate 500 and an unmapped Prisma error, not expected 4xx/5xx answers or mapped Prisma codes', () => {
    filter.catch(new InternalServerErrorException('x'), host(request).args);
    expect(capture).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'unhandled', statusCode: 500 }));

    filter.catch(new Prisma.PrismaClientKnownRequestError('raw query failed', { code: 'P2010', clientVersion: 'test' }), host(request).args);
    expect(capture).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'prisma', statusCode: 500 }));

    capture.mockClear();
    filter.catch(new NotFoundException(), host(request).args);
    filter.catch(new ServiceUnavailableException({ code: 'OCR_NOT_CONFIGURED' }), host(request).args);
    filter.catch(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta: { target: ['sku'] } }), host(request).args);
    expect(capture).not.toHaveBeenCalled();
  });

  it('logs the request correlation id as a field of the error line, not only inside its text', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    filter.catch(new Prisma.PrismaClientKnownRequestError('The column `Notification.message` does not exist', { code: 'P2022', clientVersion: 'test' }), host(request).args);
    expect(error).toHaveBeenLastCalledWith({ message: 'Prisma error P2022', correlationId: 'corr-1' }, expect.stringContaining('does not exist'));
    filter.catch(new Error('kaboom'), host(request).args);
    expect(error).toHaveBeenLastCalledWith({ message: 'Unhandled exception', correlationId: 'corr-1' }, expect.stringContaining('kaboom'));
  });

  it('labels a request the router never matched as unmatched', () => {
    const { args, response } = host({ correlationId: 'corr-2', method: 'GET' });
    filter.catch(new Error('early'), args);
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ route: 'unmatched', method: 'GET' }));
  });
});

describe('GlobalExceptionFilter outages (roadmap 9.18 failure drills)', () => {
  const filter = new GlobalExceptionFilter();
  let capture: jest.SpyInstance;

  beforeEach(() => {
    capture = jest.spyOn(ErrorTracking, 'capture').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // What the drill met while MySQL was stopped: the pool could not connect, the
  // server closed the connection, and a statement met "shutdown in progress".
  const outages: Array<[string, unknown]> = [
    ['P1001 cannot reach the server', new Prisma.PrismaClientKnownRequestError("Can't reach database server at `mysql:3306`", { code: 'P1001', clientVersion: 'test' })],
    ['P1017 server closed the connection', new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: 'test' })],
    ['P2024 pool timeout', new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: 'test' })],
    ['initialisation failure', new Prisma.PrismaClientInitializationError("Can't reach database server at `mysql:3306`", 'test')],
    ['MySQL 1053 during a query', new Prisma.PrismaClientUnknownRequestError('Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(Server(MysqlError { code: 1053, message: "Server shutdown in progress", state: "08S01" })), transient: false })', { clientVersion: 'test' })],
  ];

  it.each(outages)('answers %s 503 DATABASE_UNAVAILABLE with Retry-After, and tracks no bug', (_label, error) => {
    const { args, response } = host(request);
    filter.catch(error, args);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503, code: 'DATABASE_UNAVAILABLE', correlationId: 'corr-1' }));
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps an unknown Prisma error that is not an outage a tracked 500', () => {
    const { args, response } = host(request);
    filter.catch(new Prisma.PrismaClientUnknownRequestError('some engine bug', { clientVersion: 'test' }), args);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'unhandled' }));
  });

  it('answers a full volume 507 STORAGE_FULL, also when the errno sits in the cause', () => {
    for (const error of [Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }), new Error('upload failed', { cause: Object.assign(new Error('quota'), { code: 'EDQUOT' }) })]) {
      const { args, response } = host(request);
      filter.catch(error, args);
      expect(response.status).toHaveBeenCalledWith(507);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 507, code: 'STORAGE_FULL' }));
    }
    expect(capture).not.toHaveBeenCalled();
  });
});
