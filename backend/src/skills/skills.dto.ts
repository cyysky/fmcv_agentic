import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Skill names are unique and tool-call friendly (slug-form). */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_SKILL_CONTENT = 200_000;

const NAME_MESSAGE =
  'name must start with a letter or digit and use letters, digits, dash or underscore only (max 64 chars)';

/** Author a new skill. Content is optional at creation but required before
 *  the skill can be installed and used by agents. */
export class CreateSkillDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(SKILL_NAME_RE, { message: NAME_MESSAGE })
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SKILL_CONTENT)
  content?: string;

  @IsOptional()
  @IsBoolean()
  installed?: boolean;
}

/** Update any subset of a skill's fields. */
export class UpdateSkillDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(SKILL_NAME_RE, { message: NAME_MESSAGE })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SKILL_CONTENT)
  content?: string;

  @IsOptional()
  @IsBoolean()
  installed?: boolean;
}
