import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { BaseAgentService } from './base-agent.service';
import { WorkspaceService } from './workspace.service';
import {
  AskAgentDto,
  ConverseDto,
  CreateSessionDto,
  CreateWorkspaceAgentDto,
  CreateWorkspaceProjectDto,
  RenameSessionDto,
  RunTurnDto,
} from './agent.dto';

/**
 * HTTP surface for the FMCC Agentic base agent.
 *
 * Endpoints mirror the stateless / sessionful split exposed by the base
 * agent service:
 *   POST /api/agent/turn     — stateless single-turn answer
 *   POST /api/agent/sessions — create a session
 *   GET  /api/agent/sessions — list sessions
 *   GET  /api/agent/sessions/:id — read one session
 *   POST /api/agent/sessions/:id/converse — append + run the loop
 *   DELETE /api/agent/sessions/:id — drop a session
 *   GET  /api/agent/models   — model catalog for the picker
 *   GET  /api/agent/defaults — provider / default-model info
 */
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: BaseAgentService,
    private readonly workspaces: WorkspaceService,
  ) {}

  /* ---------------------------- stateless turn ---------------------------- */

  @Post('turn')
  runTurn(@Body() dto: RunTurnDto) {
    return this.agent.runTurn({
      message: dto.message,
      history: dto.history,
      model: dto.model,
      maxSteps: dto.maxSteps,
    });
  }

  /* ---------------------------- sessions ---------------------------- */

  @Post('sessions')
  createSession(@Body() dto: CreateSessionDto) {
    return this.agent.createSession(dto.title, dto.model);
  }

  @Get('sessions')
  listSessions() {
    return this.agent.listSessions();
  }

  @Get('sessions/:id')
  getSession(@Param('id', ParseUUIDPipe) id: string) {
    return this.agent.getSession(id);
  }

  @Post('sessions/:id/converse')
  converse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConverseDto) {
    return this.agent.converse(id, dto.message, dto.model, dto.maxSteps);
  }

  @Patch('sessions/:id')
  renameSession(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameSessionDto) {
    return this.agent.renameSession(id, dto.title);
  }

  @Delete('sessions/:id')
  deleteSession(@Param('id', ParseUUIDPipe) id: string) {
    return this.agent.deleteSession(id);
  }

  /* ---------------------------- model metadata ---------------------------- */

  @Get('models')
  models() {
    return this.agent.getCatalog();
  }

  @Get('defaults')
  defaults() {
    return this.agent.getDefaults();
  }

  /* ---------------------------- workspaces ---------------------------- */

  @Get('workspaces')
  async workspacesInfo() {
    return this.workspaces.getWorkspaceInfo();
  }

  @Post('workspaces/projects')
  createWorkspaceProject(@Body() dto: CreateWorkspaceProjectDto) {
    return this.workspaces.createPublicProject(dto.name);
  }

  @Post('workspaces/agents')
  ensureWorkspaceAgent(@Body() dto: CreateWorkspaceAgentDto) {
    return this.workspaces.ensureAgentFolder(dto.name);
  }

  @Get('workspaces/projects/:name')
  listWorkspaceProject(@Param('name') name: string) {
    return this.workspaces.listProjectContent(name);
  }

  @Get('workspaces/agents/:name')
  listWorkspaceAgent(@Param('name') name: string) {
    return this.workspaces.listAgentContent(name);
  }
}
