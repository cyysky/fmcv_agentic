import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileScopeQueryDto, WriteFileDto } from './files.dto';
import { FilesService } from './files.service';

/**
 * Human-facing file manager over the agent workspace.
 *
 *   GET    /api/files/list?scope=agent:coder&path=notes
 *   GET    /api/files/read?scope=agent:coder&path=notes/hello.txt
 *   GET    /api/files/view?scope=agent:coder&path=notes/page.html
 *   GET    /api/files/download?scope=agent:coder&path=notes/hello.txt
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

  @Get('view')
  async view(@Query() query: FileScopeQueryDto, @Res() res: Response) {
    const { target, fileName, size, contentType } = await this.files.view(
      query.scope,
      query.path,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${fileName.replace(/["\r\n]/g, '_')}"`,
    );
    res.setHeader('Content-Length', String(size));
    // Serve the document sandboxed (opaque origin, no scripts/forms), so a
    // hostile HTML file cannot touch the app's own origin when it is opened
    // by link or in a new tab/window.
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(target);
  }

  @Get('download')
  async download(@Query() query: FileScopeQueryDto, @Res() res: Response) {
    const { target, fileName, size } = await this.files.download(
      query.scope,
      query.path,
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`,
    );
    res.setHeader('Content-Length', String(size));
    res.sendFile(target);
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
