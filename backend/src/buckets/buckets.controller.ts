import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CreateBucketDto, RenameBucketDto } from './buckets.dto';
import { BucketsService } from './buckets.service';
import type { UploadedFileLike } from './buckets.service';

/**
 * Managed document buckets.
 *
 *   POST       /api/buckets                               create (unique name)
 *   GET        /api/buckets                               list
 *   GET        /api/buckets/:id                           get one + documents
 *   GET        /api/buckets/:id/documents                 list documents
 *   POST       /api/buckets/:id/documents                 upload a managed document
 *   PATCH      /api/buckets/:id                           rename (unique name,
 *                                                         folder moved to match)
 *   DELETE     /api/buckets/:id                           delete bucket + all
 *                                                         documents (folder removed)
 *   GET        /api/buckets/:id/documents/:docId/download stream the document
 *
 * Buckets can be renamed or deleted; documents stay immutable once added
 * (never edited or overwritten).
 */
@Controller('buckets')
export class BucketsController {
  constructor(private readonly buckets: BucketsService) {}

  @Post()
  create(@Body() dto: CreateBucketDto) {
    return this.buckets.createBucket(dto);
  }

  @Get()
  list() {
    return this.buckets.listBuckets();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.buckets.getBucket(id);
  }

  @Patch(':id')
  rename(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameBucketDto) {
    return this.buckets.renameBucket(id, dto.name);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.buckets.deleteBucket(id);
  }

  @Get(':id/documents')
  documents(@Param('id', ParseUUIDPipe) id: string) {
    return this.buckets.listDocuments(id);
  }

  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.buckets.addDocument(id, file);
  }

  @Get(':id/documents/:documentId/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ) {
    const { target, fileName, mimeType, size } =
      await this.buckets.resolveDownload(id, documentId);
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`,
    );
    res.setHeader('Content-Length', String(size));
    res.sendFile(target);
  }
}
