import * as path from 'path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StorageConfig } from '../config/domains/storage.config';
import { StorageCustomerDirectory } from './storage-security.constants';

/**
 * Every filesystem path the storage module touches comes from here
 * (roadmap 7.5): the root is resolved once (`path.resolve`, so the committed
 * relative `./data/storage` is pinned to the boot-time working directory and
 * production, which must set an absolute root, is unaffected), every id is
 * reduced to a safe segment, and every join is contained with
 * `path.relative`: a result that leaves its base (`..`, an absolute segment,
 * or a sibling that merely shares the prefix such as `<root>2`) is refused.
 * Responses never carry an absolute path: `relativeToShop` turns one into
 * the shop-relative form.
 */
@Injectable()
export class StoragePathBuilder {
  private readonly logger = new Logger(StoragePathBuilder.name);
  private readonly storageRoot: string;

  constructor(private storageConfig: StorageConfig) {
    this.storageRoot = path.resolve(this.storageConfig.storageRoot || path.join(process.cwd(), 'data', 'storage'));
    this.logger.log(`Storage root resolved to ${this.storageRoot}`);
  }

  /** The resolved, absolute storage root. */
  get root(): string {
    return this.storageRoot;
  }

  private sanitizeSegment(segment: string): string {
    if (!segment || typeof segment !== 'string') {
      throw new BadRequestException('Invalid path segment');
    }
    const sanitized = segment.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized) {
      throw new BadRequestException('Path segment contains invalid characters');
    }
    return sanitized;
  }

  /** True when `target` is `base` itself or lives under it. */
  static isContained(base: string, target: string): boolean {
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private secureJoin(base: string, ...segments: string[]): string {
    const resolved = path.resolve(base, ...segments);
    if (!StoragePathBuilder.isContained(base, resolved)) {
      throw new BadRequestException('Directory traversal detected');
    }
    return resolved;
  }

  /**
   * Root path for all data of a single tenant.
   * Format: data/storage/{shopId}
   */
  getShopRoot(shopId: string): string {
    const safeShopId = this.sanitizeSegment(shopId);
    return this.secureJoin(this.storageRoot, safeShopId);
  }

  /**
   * An absolute path under the shop root in its shop-relative, forward-slash
   * form (`Customers/<id>/Profile`), the only form a response may carry.
   */
  relativeToShop(shopId: string, absolutePath: string): string {
    const shopRoot = this.getShopRoot(shopId);
    if (!StoragePathBuilder.isContained(shopRoot, absolutePath)) {
      throw new BadRequestException('Path is outside the shop storage');
    }
    return path.relative(shopRoot, absolutePath).split(path.sep).join('/');
  }

  /**
   * Path for a specific customer directory within a shop.
   * Format: data/storage/{shopId}/Customers/{customerId}/{category}
   */
  getCustomerDirectory(shopId: string, customerId: string, category: StorageCustomerDirectory | 'Profile'): string {
    const safeCustomerId = this.sanitizeSegment(customerId);
    const shopRoot = this.getShopRoot(shopId);
    return this.secureJoin(shopRoot, 'Customers', safeCustomerId, category);
  }

  /**
   * Path for tenant-specific system files.
   * Format: data/storage/{shopId}/System/{filename}
   */
  getSystemFile(shopId: string, filename: string): string {
    const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
    const shopRoot = this.getShopRoot(shopId);
    return this.secureJoin(shopRoot, 'System', safeFilename);
  }

  /**
   * Path for tenant-specific logs.
   * Format: data/storage/{shopId}/Logs/{filename}
   */
  getLogFile(shopId: string, filename: string): string {
    const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
    const shopRoot = this.getShopRoot(shopId);
    return this.secureJoin(shopRoot, 'Logs', safeFilename);
  }

  /**
   * Path for tenant backups.
   * Format: data/storage/{shopId}/Backups/{type}
   */
  getBackupDirectory(shopId: string, type: string): string {
    const safeType = this.sanitizeSegment(type);
    const shopRoot = this.getShopRoot(shopId);
    return this.secureJoin(shopRoot, 'Backups', safeType);
  }

  /**
   * Path for soft-deleted files.
   * Format: data/storage/{shopId}/Deleted/{targetFilename}
   */
  getDeletedFileTarget(shopId: string, originalFilename: string): string {
    const timestamp = Date.now();
    const randomHex = Math.random().toString(16).substring(2, 8);
    // Allow dots for extension
    const safeOriginal = originalFilename.replace(/[^a-zA-Z0-9_.-]/g, '');
    const ext = path.extname(safeOriginal);
    const targetFilename = `${timestamp}-${randomHex}${ext}`;
    const shopRoot = this.getShopRoot(shopId);
    return this.secureJoin(shopRoot, 'Deleted', targetFilename);
  }

  /**
   * Prefix for all S3 keys belonging to this tenant.
   * Format: {shopId}/{folder}
   */
  getS3Prefix(shopId: string, folder: string): string {
    const safeShopId = this.sanitizeSegment(shopId);
    const safeFolder = this.sanitizeSegment(folder);
    return `${safeShopId}/${safeFolder}`;
  }
}
