import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { finalize } from 'rxjs';
import { discardUpload } from './upload-options';

type UploadedFiles = Express.Multer.File | Express.Multer.File[] | Record<string, Express.Multer.File[]> | undefined;

/** Every multer file of the request that was stored on disk (`path` set). */
export function requestUploads(req: Pick<Request, 'file' | 'files'>): Array<{ path?: string }> {
  const files: Array<{ path?: string }> = [];
  const push = (value: UploadedFiles) => {
    if (!value) return;
    if (Array.isArray(value)) files.push(...value);
    else if ('fieldname' in value) files.push(value);
    else for (const list of Object.values(value)) files.push(...list);
  };
  push(req.file);
  push(req.files);
  return files.filter((f) => typeof f.path === 'string' && f.path.length > 0);
}

/**
 * Safety net for disk-stored uploads (roadmap 5.1): whatever ends the request
 * after multer wrote the temp file (a body-validation 400 from the global
 * pipe, an ownership 404 thrown before the handler's own cleanup, an
 * unexpected error), the file is unlinked once the handler's observable
 * completes or errors. The happy paths rename or unlink the file themselves,
 * so this is a no-op for them (ENOENT is ignored). List it BEFORE the
 * FileInterceptor in `@UseInterceptors` so it wraps the whole chain.
 */
@Injectable()
export class UploadCleanupInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UploadCleanupInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): ReturnType<CallHandler['handle']> {
    const req = context.switchToHttp().getRequest<Request>();
    const cleanup = finalize(() => {
      for (const file of requestUploads(req)) {
        void discardUpload(file).catch((error: unknown) => this.logger.warn(`Could not discard upload ${file.path}: ${String(error)}`));
      }
    });
    // Two rxjs copies in the workspace (see PagedListInterceptor): same code, distinct types.
    return next.handle().pipe(cleanup as unknown as Parameters<ReturnType<CallHandler['handle']>['pipe']>[0]);
  }
}
