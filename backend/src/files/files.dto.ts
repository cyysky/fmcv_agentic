import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Query parameters shared by the file endpoints. */
export class FileScopeQueryDto {
  @IsString()
  @IsNotEmpty()
  scope: string;

  @IsOptional()
  @IsString()
  path?: string;
}

/** Body for PUT /api/files/write (empty string allowed). */
export class WriteFileDto {
  @IsOptional()
  @IsString()
  content?: string;
}
