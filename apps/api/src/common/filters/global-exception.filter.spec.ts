import { ArgumentsHost, HttpStatus, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorTracking } from '../observability/error-tracking';
import { GlobalExceptionFilter } from './global-exception.filter';

function host(request: Record<string, unknown>) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
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

    filter.catch(new Prisma.PrismaClientKnownRequestError('cannot reach', { code: 'P1001', clientVersion: 'test' }), host(request).args);
    expect(capture).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'prisma', statusCode: 500 }));

    capture.mockClear();
    filter.catch(new NotFoundException(), host(request).args);
    filter.catch(new ServiceUnavailableException({ code: 'OCR_NOT_CONFIGURED' }), host(request).args);
    filter.catch(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta: { target: ['sku'] } }), host(request).args);
    expect(capture).not.toHaveBeenCalled();
  });

  it('labels a request the router never matched as unmatched', () => {
    const { args, response } = host({ correlationId: 'corr-2', method: 'GET' });
    filter.catch(new Error('early'), args);
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ route: 'unmatched', method: 'GET' }));
  });
});
