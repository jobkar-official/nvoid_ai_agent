import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { JobProfileDto } from './search-jobs.dto';

export class RunAgentDto {
  @IsString()
  userId!: string;

  @ValidateNested()
  @Type(() => JobProfileDto)
  profile!: JobProfileDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  searchLimit = 100;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  applyLimit = 100;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minMatchScore = 60;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  serverIds?: string[];

  @IsOptional()
  @IsBoolean()
  autoSubmit = false;

  @IsOptional()
  @IsBoolean()
  syncToBackend = true;
}
