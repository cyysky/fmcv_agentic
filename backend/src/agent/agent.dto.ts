import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  Matches,
  IsString,
  Max,
  MaxLength,
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

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSteps?: number;
}

/** Rename an existing session (trimmed server-side; blank rejected). */
export class RenameSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;
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

/** Body for creating a public project folder. */
export class CreateWorkspaceProjectDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'name must be alphanumeric, dash or underscore only',
  })
  name: string;
}

/** Body for ensuring a named agent folder exists. */
export class CreateWorkspaceAgentDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'name must be alphanumeric, dash or underscore only',
  })
  name: string;
}

/* ------------------------------ channels ------------------------------ */

/** Create a team channel (owns one project folder). */
export class CreateChannelDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  projectName?: string;

  @IsOptional()
  @IsString()
  creatorAgent?: string;
}

/** Add/remove a named agent to a channel. */
export class ChannelMemberDto {
  @IsString()
  @IsNotEmpty()
  agentName: string;
}

/** Post a message to the channel feed as a human/user. */
export class ChannelMessageDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsOptional()
  @IsString()
  author?: string;

  /** Ignored by the backend (always stored as 'user' for human posts), but
   *  whitelisted so the frontend payload is accepted under ValidationPipe. */
  @IsOptional()
  @IsIn(['user', 'agent', 'system'])
  role?: string;
}

/** Ask a channel-members agent to work in the channel. */
export class ChannelTurnDto {
  @IsString()
  @IsNotEmpty()
  agentName: string;

  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsString()
  model?: string;
}

/** Start a streaming channel turn as a background job. */
export class CreateChannelJobDto {
  @IsString()
  @IsNotEmpty()
  agentName: string;

  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSteps?: number;
}

/** Interject user text into a running channel job. */
export class ChannelInterjectDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}
