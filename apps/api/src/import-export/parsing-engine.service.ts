import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import csvParser from 'csv-parser';
import { MAX_IMPORT_ROWS } from './import-rows';

/**
 * One CSV line may hold at most this many bytes (a shop's longest product
 * row is a few hundred): csv-parser's default is unlimited, so one endless
 * "line" was read into memory whole.
 */
export const MAX_IMPORT_ROW_BYTES = 64 * 1024;

/**
 * A JSON import is parsed in one piece (`JSON.parse` has no streaming form),
 * so its size is capped well below the upload cap: 2 MB is about 13,000
 * product rows. Larger catalogues use the CSV template, which streams.
 */
export const MAX_IMPORT_JSON_BYTES = 2 * 1024 * 1024;

export const IMPORT_TOO_MANY_ROWS = 'IMPORT_TOO_MANY_ROWS';
export const IMPORT_FILE_TOO_LARGE = 'IMPORT_FILE_TOO_LARGE';

function tooManyRows(maxRows: number): BadRequestException {
  return new BadRequestException({ message: `The file has more than ${maxRows} rows; one import takes at most ${maxRows}. Split it into smaller files.`, code: IMPORT_TOO_MANY_ROWS });
}

/**
 * Reads an import file into records, bounded (audit F1 / P1-8): the CSV is
 * streamed and counted, and reading stops (the stream is destroyed) at the
 * first record past `maxRows`, so a file of millions of two-byte rows costs
 * `maxRows` records, never the whole file in memory; a single row is capped at
 * MAX_IMPORT_ROW_BYTES. A JSON file over MAX_IMPORT_JSON_BYTES is refused
 * before it is read. Before, every record was collected first and the row
 * cap applied afterwards: a 20 MB upload of tiny rows took about 1.9 GB of
 * heap, enough for any self-registered owner to take the API down (and
 * BullMQ redelivered the job).
 */
@Injectable()
export class ParsingEngineService {
  async parseCsv(filePath: string, maxRows: number = MAX_IMPORT_ROWS): Promise<Array<Record<string, string>>> {
    return new Promise((resolve, reject) => {
      const results: Array<Record<string, string>> = [];
      const source = fs.createReadStream(filePath);
      const parser = csvParser({ maxRowBytes: MAX_IMPORT_ROW_BYTES });
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        source.unpipe(parser);
        source.destroy();
        parser.destroy();
        reject(error);
      };
      source.on('error', (err) => fail(new BadRequestException(`Failed to read CSV: ${err.message}`)));
      parser.on('error', (err: Error) =>
        fail(/maximum size/i.test(err.message) ? new BadRequestException({ message: `A line of the file is longer than ${MAX_IMPORT_ROW_BYTES} bytes; check the file is a CSV with one record per line.`, code: IMPORT_FILE_TOO_LARGE }) : new BadRequestException(`Failed to parse CSV: ${err.message}`)),
      );
      parser.on('data', (row: Record<string, string>) => {
        if (settled) return;
        if (results.length >= maxRows) {
          fail(tooManyRows(maxRows));
          return;
        }
        results.push(row);
      });
      parser.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(results);
      });
      source.pipe(parser);
    });
  }

  async parseJson(filePath: string, maxRows: number = MAX_IMPORT_ROWS): Promise<unknown[]> {
    let size: number;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch (err) {
      throw new BadRequestException(`Failed to read JSON: ${(err as Error).message}`);
    }
    if (size > MAX_IMPORT_JSON_BYTES) {
      throw new BadRequestException({
        message: `A JSON import may be at most ${MAX_IMPORT_JSON_BYTES / 1024 / 1024} MB (this one is ${(size / 1024 / 1024).toFixed(1)} MB); use the CSV template for a larger file.`,
        code: IMPORT_FILE_TOO_LARGE,
      });
    }
    let data: unknown;
    try {
      data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (err) {
      throw new BadRequestException(`Failed to parse JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(data)) throw new BadRequestException('Failed to parse JSON: Root JSON element must be an array');
    if (data.length > maxRows) throw tooManyRows(maxRows);
    return data;
  }

  /**
   * Universal parser router.
   */
  async parseFile(filePath: string, format: string, maxRows: number = MAX_IMPORT_ROWS): Promise<Array<Record<string, unknown>>> {
    if (format.toUpperCase() === 'CSV') {
      return this.parseCsv(filePath, maxRows);
    } else if (format.toUpperCase() === 'JSON') {
      return (await this.parseJson(filePath, maxRows)) as Array<Record<string, unknown>>;
    } else {
      throw new BadRequestException(`Unsupported format: ${format}`);
    }
  }
}
