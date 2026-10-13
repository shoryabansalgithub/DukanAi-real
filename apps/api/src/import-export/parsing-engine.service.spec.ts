import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IMPORT_FILE_TOO_LARGE, IMPORT_TOO_MANY_ROWS, MAX_IMPORT_JSON_BYTES, ParsingEngineService } from './parsing-engine.service';
import { MAX_IMPORT_ROWS } from './import-rows';

jest.setTimeout(60_000);

/**
 * Audit F1 / P1-8: an import file is read within its limits. Two million
 * two-byte rows (a 4 MB upload, well under the 20 MB cap) are refused after
 * MAX_IMPORT_ROWS + 1 records instead of being collected whole.
 */
describe('ParsingEngineService bounds', () => {
  const engine = new ParsingEngineService();
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-spec-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string | Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('stops reading a CSV at the first row past the limit, without collecting the file', async () => {
    const file = write('huge.csv', `n\n${'x\n'.repeat(2_000_000)}`);
    let peak = 0;
    const before = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed - before)), 5);
    const started = Date.now();
    const error = await engine.parseCsv(file).catch((e: unknown) => e);
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    expect(error).toMatchObject({ status: 400, response: expect.objectContaining({ code: IMPORT_TOO_MANY_ROWS }) });
    // 2,000,000 row objects would be hundreds of MB; the bounded reader holds at most MAX_IMPORT_ROWS of them.
    expect(peak).toBeLessThan(60 * 1024 * 1024);
    // It stopped at row 50,001 instead of parsing the remaining 1,950,000.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('returns every record of a file within the limit, and refuses one row past it', async () => {
    const ok = write('ok.csv', `sku,name\n${Array.from({ length: 10 }, (_, i) => `S${i},Item ${i}`).join('\n')}\n`);
    await expect(engine.parseCsv(ok, 10)).resolves.toHaveLength(10);
    await expect(engine.parseCsv(ok, 9)).rejects.toMatchObject({ response: expect.objectContaining({ code: IMPORT_TOO_MANY_ROWS }) });
    expect(MAX_IMPORT_ROWS).toBe(50_000);
  });

  it('refuses a line longer than the row cap instead of reading it into memory', async () => {
    const file = write('long-line.csv', `n\n${'y'.repeat(200 * 1024)}\n`);
    await expect(engine.parseCsv(file)).rejects.toMatchObject({ response: expect.objectContaining({ code: IMPORT_FILE_TOO_LARGE }) });
  });

  it('refuses a JSON file over the JSON cap before reading it, and an array past the row limit', async () => {
    const big = write('big.json', `[${'0,'.repeat(MAX_IMPORT_JSON_BYTES / 2)}0]`);
    const readSpy = jest.spyOn(fs.promises, 'readFile');
    await expect(engine.parseJson(big)).rejects.toMatchObject({ response: expect.objectContaining({ code: IMPORT_FILE_TOO_LARGE }) });
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    const many = write('many.json', JSON.stringify(Array.from({ length: 11 }, () => ({}))));
    await expect(engine.parseJson(many, 10)).rejects.toMatchObject({ response: expect.objectContaining({ code: IMPORT_TOO_MANY_ROWS }) });
    await expect(engine.parseJson(many, 11)).resolves.toHaveLength(11);
  });
});
