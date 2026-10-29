import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { JobProfileDto } from './search-jobs.dto';

export class ApplicationJobDto {
  @IsString()
  @MaxLength(160)
  id!: string;

  @IsString()
  @MaxLength(80)
  source!: string;

  @IsOptional()
  @IsString()
  sourceJobId?: string;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  jobUrl?: string;

  @IsOptional()
  @IsString()
  applicationUrl?: string;

  @IsOptional()
  @IsString()
  salaryCurrency?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  matchScore?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  matchReasons?: string[];

  @IsOptional()
  @IsObject()
  raw?: Record<string, unknown>;
}

export class EnqueueApplicationsDto {
  @IsString()
  userId!: string;

  @ValidateNested()
  @Type(() => JobProfileDto)
  profile!: JobProfileDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApplicationJobDto)
  jobs!: ApplicationJobDto[];

  @IsOptional()
  @IsBoolean()
  autoSubmit = false;
}
