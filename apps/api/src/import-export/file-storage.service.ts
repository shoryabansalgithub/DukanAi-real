import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly importsDir = path.join(process.cwd(), 'uploads', 'imports');
  private readonly exportsDir = path.join(process.cwd(), 'uploads', 'exports');

  constructor() {
    this.ensureDirectories();
  }

  private ensureDirectories() {
    if (!fs.existsSync(this.importsDir)) fs.mkdirSync(this.importsDir, { recursive: true });
    if (!fs.existsSync(this.exportsDir)) fs.mkdirSync(this.exportsDir, { recursive: true });
  }

  /**
   * Moves a disk-stored upload (or writes a memory one) into the imports
   * directory under a server-chosen name and returns that path.
   */
  async saveImportFile(shopId: string, file: Express.Multer.File): Promise<string> {
    try {
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${shopId}-${uuidv4()}${ext}`;
      const filePath = path.join(this.importsDir, filename);

      if (file.path) {
        await fs.promises.rename(file.path, filePath).catch(async () => {
          // Temp and imports directories may sit on different file systems.
          await fs.promises.copyFile(file.path, filePath);
          await fs.promises.unlink(file.path).catch(() => undefined);
        });
      } else {
        await fs.promises.writeFile(filePath, file.buffer ?? Buffer.alloc(0));
      }
      this.logger.log(`Saved import file to ${filePath}`);
      return filePath;
    } catch (err) {
      this.logger.error(`Failed to save import file: ${(err as Error).message}`);
      throw new InternalServerErrorException('Failed to process file upload');
    }
  }

  getExportPath(shopId: string, format: string): string {
    const filename = `${shopId}-export-${Date.now()}.${format.toLowerCase()}`;
    return path.join(this.exportsDir, filename);
  }
}
