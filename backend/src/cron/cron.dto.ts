import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 5-field cron expression: minute hour day-of-month month day-of-week. */
export const CRON_SCHEDULE_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

const SCHEDULE_MESSAGE =
  'schedule must be a five-field cron expression (minute hour day-of-month month day-of-week), e.g. "*/15 * * * *"';

/** Create a recurring agent-turn cron job. */
export class CreateCronJobDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsString()
  @Matches(CRON_SCHEDULE_RE, { message: SCHEDULE_MESSAGE })
  schedule: string;

  @IsOptional()
  @IsIn(['agent-turn'], { message: 'taskType must be "agent-turn"' })
  taskType?: 'agent-turn';

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsUUID()
  connectionId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSteps?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Update any subset of a cron job's fields. */
export class UpdateCronJobDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(CRON_SCHEDULE_RE, { message: SCHEDULE_MESSAGE })
  schedule?: string;

  @IsOptional()
  @IsIn(['agent-turn'], { message: 'taskType must be "agent-turn"' })
  taskType?: 'agent-turn';

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsUUID()
  connectionId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSteps?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
