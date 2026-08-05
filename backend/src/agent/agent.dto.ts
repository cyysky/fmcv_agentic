import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Body wrapper for asking the agent a question (non-streaming). */
export class AskAgentDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSteps?: number;
}

/** A single chat message in a session transcript. */
export class ChatMessageDto {
  @IsIn(['system', 'user', 'assistant', 'tool'])
  role: 'system' | 'user' | 'assistant' | 'tool';

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  toolCallId?: string;

  @IsOptional()
  @IsObject()
  toolCalls?: Record<string, unknown>[];
}

/** Create a new agent session. */
export class CreateSessionDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  model?: string;
}

/** Append a user message to an existing session and run the loop. */
export class ConverseDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsString()
  model?: string;
}

/** Manually build a conversation for the stateless turn. */
export class RunTurnDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  history?: string[];

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSteps?: number;
}
