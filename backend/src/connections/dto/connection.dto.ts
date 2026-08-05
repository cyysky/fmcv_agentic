import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';

// Accept http(s) URLs including localhost/private hosts
const URL_REGEX = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export class CreateConnectionDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  displayName: string;

  @IsString()
  @Matches(URL_REGEX, { message: 'baseUrl must be a valid http(s) URL' })
  baseUrl: string;

  @IsString()
  @IsNotEmpty()
  modelName: string;

  @IsInt()
  @Min(1)
  @Max(2000000)
  contextLength: number;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  concurrentConnections?: number;
}

export class UpdateConnectionDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  displayName?: string;

  @IsString()
  @Matches(URL_REGEX, { message: 'baseUrl must be a valid http(s) URL' })
  @IsOptional()
  baseUrl?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  modelName?: string;

  @IsInt()
  @Min(1)
  @Max(2000000)
  @IsOptional()
  contextLength?: number;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  concurrentConnections?: number;
}

