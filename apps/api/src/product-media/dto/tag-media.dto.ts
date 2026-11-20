import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class TagMediaDto {
  @IsString()
  assetId: string;

  @IsString()
  @MaxLength(100)
  tag: string;
}

/** Multipart field of the upload routes; multipart values arrive as strings. */
export class UploadMediaDto {
  @IsOptional()
  @IsString()
  isPrimary?: string;
}

/** New display order of the references of one product or variant (exactly one of the two). */
export class ReorderMediaDto {
  @ValidateIf((o: ReorderMediaDto) => !o.variantId)
  @IsString()
  productId?: string;

  @ValidateIf((o: ReorderMediaDto) => !o.productId)
  @IsString()
  variantId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  referenceIds: string[];
}

/** The thumbnail sizes the media worker renders. */
export const MEDIA_THUMBNAIL_SIZES = ['100px', '300px', '600px'] as const;

/** `GET /media/assets/:id/file[?size=300px]`: the original, or one of its thumbnails. */
export class MediaFileQueryDto {
  @IsOptional()
  @IsIn(MEDIA_THUMBNAIL_SIZES)
  size?: (typeof MEDIA_THUMBNAIL_SIZES)[number];
}
