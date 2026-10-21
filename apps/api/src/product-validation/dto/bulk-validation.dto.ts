import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

export class BulkValidationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  productIds: string[];
}
