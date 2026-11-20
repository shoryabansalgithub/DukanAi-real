import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export type JsonObject = Record<string, unknown>;

/**
 * For the few bodies that are free-form JSON documents by design (a product
 * revision snapshot, workflow conditions). `ValidationPipe` cannot whitelist
 * an open document, so this pipe makes the acceptance explicit: a plain,
 * non-array object, nothing else. Never hand its result to Prisma `data`
 * without picking the fields you mean to write.
 */
@Injectable()
export class JsonObjectPipe implements PipeTransform<unknown, JsonObject> {
  transform(value: unknown): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Request body must be a JSON object.');
    }
    return value as JsonObject;
  }
}
