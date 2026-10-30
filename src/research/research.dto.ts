import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ResearchRunDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  query!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  serverIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxRecords = 100;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  maxTools = 20;
}
