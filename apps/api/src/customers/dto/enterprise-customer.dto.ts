import { IsEmail, IsEnum, IsNumber, IsOptional, IsString, MaxLength, ValidateNested, IsBoolean, IsArray } from 'class-validator';
import { Type } from 'class-transformer';
import { CustomerType, CustomerLifecycleStatus, ContactRole, AddressType } from '../domain/enums';

export class CustomerProfileDto {
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() pan?: string;
  @IsOptional() @IsString() businessType?: string;
  @IsOptional() @IsString() registrationNo?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() profilePicture?: string;
  @IsOptional() customFields?: any;
}

export class CustomerAddressDto {
  @IsEnum(AddressType) type: AddressType;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsString() addressLine: string;
  @IsString() city: string;
  @IsString() state: string;
  @IsOptional() @IsString() district?: string;
  @IsString() country: string;
  @IsString() postalCode: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
}

export class CustomerContactDto {
  @IsEnum(ContactRole) role: ContactRole;
  @IsString() name: string;
  @IsString() phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateEnterpriseCustomerDto {
  @IsString() @MaxLength(100) name: string;
  @IsString() @MaxLength(20) phone: string;
  @IsOptional() @IsEmail() email?: string;
  
  @IsOptional() @IsEnum(CustomerType) type?: CustomerType;
  @IsOptional() @IsEnum(CustomerLifecycleStatus) lifecycleStatus?: CustomerLifecycleStatus;
  
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerProfileDto)
  profile?: CustomerProfileDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  addresses?: CustomerAddressDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerContactDto)
  contacts?: CustomerContactDto[];
}
