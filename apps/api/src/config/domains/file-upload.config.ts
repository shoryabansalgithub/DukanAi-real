import { Injectable } from '@nestjs/common';
import { ConfigDomain } from '../registry/registry.decorators';
import { IsOptional, IsArray } from 'class-validator';

@Injectable()
@ConfigDomain({ owner: 'FileUpload', feature: 'Configuration', version: '1.0.0', description: 'FileUploadConfig Domain' })
export class FileUploadConfig {
  @IsOptional()
  @IsArray()
  allowedExtensions?: string[];
}
