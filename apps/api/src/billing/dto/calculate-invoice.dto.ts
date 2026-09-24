import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceItemDto, PaymentTenderDto } from './create-invoice.dto';

export class CalculateInvoiceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  @ApiProperty({ type: [InvoiceItemDto] })
  items: InvoiceItemDto[];

  @IsString() @IsOptional() @ApiPropertyOptional() customerId?: string;

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @IsOptional() @ApiPropertyOptional() discountAmount?: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100) @IsOptional() @ApiPropertyOptional() discountPercentage?: number;
  @IsEnum(['FIXED_AMOUNT', 'PERCENTAGE']) @IsOptional() @ApiPropertyOptional({ enum: ['FIXED_AMOUNT', 'PERCENTAGE'] }) discountType?: string;

  @ValidateIf((o) => (o.discountAmount && o.discountAmount > 0) || (o.discountPercentage && o.discountPercentage > 0))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiPropertyOptional()
  discountReason?: string;

  /** Optional: validate a proposed settlement without creating an invoice. */
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => PaymentTenderDto)
  @IsOptional()
  @ApiPropertyOptional({ type: [PaymentTenderDto] })
  payments?: PaymentTenderDto[];

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @IsOptional() @ApiPropertyOptional() udharAmount?: number;
}
