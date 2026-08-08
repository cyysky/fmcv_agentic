import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Bucket names are unique and filesystem-safe (they double as folder names
 *  inside the mapped project/agent folder). */
export const BUCKET_NAME_RE = /^[A-Za-z0-9_-]+$/;

export class CreateBucketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(BUCKET_NAME_RE, {
    message: 'name must use letters, digits, dash or underscore only',
  })
  name: string;

  @IsIn(['project', 'agent'], {
    message: 'folderType must be "project" or "agent"',
  })
  folderType: 'project' | 'agent';

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  folderName: string;
}

/** Rename target for an existing bucket (same filesystem-safe rules as
 *  creation; the folder is physically renamed to match). */
export class RenameBucketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(BUCKET_NAME_RE, {
    message: 'name must use letters, digits, dash or underscore only',
  })
  name: string;
}
