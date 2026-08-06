import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { FileScopeQueryDto, WriteFileDto } from './files.dto';
import { FilesService } from './files.service';

/**
 * Human-facing file manager over the agent workspace.
 *
 *   GET    /api/files/list?scope=agent:coder&path=notes
 *   GET    /api/files/read?scope=agent:coder&path=notes/hello.txt
 *   PUT    /api/files/write?scope=agent:coder&path=notes/hello.txt
 *   POST   /api/files/mkdir?scope=agent:coder&path=notes/newdir
 *   DELETE /api/files/delete?scope=agent:coder&path=notes/hello.txt
 *
 * `agent:<name>` scopes are read/write; `project:<name>` scopes are
 * read-only (the agent tools never write into public projects either).
 */
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get('list')
  list(@Query() query: FileScopeQueryDto) {
    return this.files.list(query.scope, query.path);
  }

  @Get('read')
  read(@Query() query: FileScopeQueryDto) {
    return this.files.read(query.scope, query.path);
  }

  @Put('write')
  write(@Query() query: FileScopeQueryDto, @Body() dto: WriteFileDto) {
    return this.files.write(query.scope, query.path, dto.content);
  }

  @Post('mkdir')
  mkdir(@Query() query: FileScopeQueryDto) {
    return this.files.mkdir(query.scope, query.path);
  }

  @Delete('delete')
  remove(@Query() query: FileScopeQueryDto) {
    return this.files.remove(query.scope, query.path);
  }
}
