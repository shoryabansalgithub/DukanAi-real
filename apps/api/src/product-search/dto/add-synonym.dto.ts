import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddSynonymDto {
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  term: string;

  /** Comma-separated synonyms, as the search engine stores them (the column is VARCHAR(191)). */
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  synonyms: string;
}
