import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Bucket, ManagedDocument, Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../agent/workspace.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBucketDto } from './buckets.dto';

/** Managed-document kinds; anything unrecognized lands in "other". */
export type DocumentKind = 'pdf' | 'text' | 'video' | 'audio' | 'other';

export interface BucketWithCount extends Bucket {
  _count?: { documents: number };
}

export interface UploadedFileLike {
  fieldname?: string;
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

export const MAX_BUCKET_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
const TEXT_EXT = new Set([
  '',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.yml',
  '.yaml',
  '.html',
  '.css',
]);

/** Sanitize an uploaded file name into a safe bucket-folder file name:
 *  basename only, control characters stripped, capped at 180 chars. */
function sanitizeFileName(raw: string | undefined): string {
  let name = path
    .basename(String(raw ?? ''))
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127; // printable chars only
    })
    .join('');
  name = name.trim();
  if (!name || name === '.' || name === '..') name = 'document';
  if (name.length > 180) {
    const ext = path.extname(name);
    name = `${name.slice(0, 180 - ext.length)}${ext}`;
  }
  return name;
}

/** Derive the managed-document kind from MIME type, then file extension. */
export function deriveDocumentKind(
  mimeType: string | undefined,
  fileName: string | undefined,
): DocumentKind {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = path.extname(fileName ?? '').toLowerCase();
  if (mime.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/**
 * Managed document buckets (DIRECTION.md item 1).
 *
 * A bucket is a uniquely named, read-only container mapped to a project
 * folder or an agent folder. Physical content is stored on disk under the
 * mapped folder (`<folderRoot>/<bucket name>/<file name>`) — a bucket folder
 * per bucket, so a project/agent folder can hold many buckets. Bucket
 * metadata has no update/delete endpoints (read-only); documents can only be
 * added and read, and a file name can never be uploaded twice into the same
 * bucket (`wx` file creation + a DB unique index both enforce this).
 */
@Injectable()
export class BucketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
  ) {}

  /** Create a bucket: validate the mapped folder, make the bucket folder,
   *  and record the row. Bucket names are globally unique (409 on clash). */
  async createBucket(dto: CreateBucketDto): Promise<Bucket> {
    const mappedRoot = await this.resolveMappedRoot(
      dto.folderType,
      dto.folderName,
    );
    const bucketDir = path.join(mappedRoot, dto.name);
    try {
      await fs.mkdir(bucketDir, { recursive: true });
    } catch (err) {
      throw new BadRequestException(
        `Cannot create bucket folder: ${(err as Error).message}`,
      );
    }
    try {
      return await this.prisma.bucket.create({
        data: {
          name: dto.name,
          folderType: dto.folderType,
          folderName: dto.folderName,
        },
      });
    } catch (err) {
      // Roll back the folder when the (unique) name already exists.
      if (this.isUniqueViolation(err)) {
        await fs.rmdir(bucketDir).catch(() => undefined);
        throw new ConflictException(`Bucket name "${dto.name}" already exists`);
      }
      await fs.rmdir(bucketDir).catch(() => undefined);
      throw err;
    }
  }

  async listBuckets(): Promise<BucketWithCount[]> {
    return this.prisma.bucket.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { documents: true } } },
    });
  }

  /** Get one bucket with its documents (no bucket editing/deleting exists —
   *  buckets are read-only). */
  async getBucket(
    id: string,
  ): Promise<Bucket & { documents: ManagedDocument[] }> {
    const bucket = await this.prisma.bucket.findUnique({
      where: { id },
      include: { documents: { orderBy: { createdAt: 'asc' } } },
    });
    if (!bucket) throw new NotFoundException(`Bucket ${id} not found`);
    return bucket;
  }

  async listDocuments(bucketId: string): Promise<ManagedDocument[]> {
    await this.getBucket(bucketId); // 404 when the bucket does not exist
    return this.prisma.managedDocument.findMany({
      where: { bucketId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Store an uploaded document once in the bucket folder and register it. */
  async addDocument(
    bucketId: string,
    file: UploadedFileLike,
  ): Promise<ManagedDocument> {
    const bucket = await this.getBucket(bucketId);
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException(
        'Multipart field "file" is required and must be non-empty',
      );
    }
    if (file.buffer.length > MAX_BUCKET_FILE_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${MAX_BUCKET_FILE_BYTES}-byte upload cap`,
      );
    }
    const name = sanitizeFileName(file.originalname);
    const mimeType = (file.mimetype ?? '').trim() || null;
    const kind = deriveDocumentKind(file.mimetype, name);
    const mappedRoot = await this.resolveMappedRoot(
      bucket.folderType as 'project' | 'agent',
      bucket.folderName,
    );
    const bucketDir = path.join(mappedRoot, bucket.name);
    const target = path.join(bucketDir, name);
    try {
      await fs.mkdir(bucketDir, { recursive: true });
      // `wx` fails when the target already exists: documents are immutable
      // once added (no overwrite, ever).
      await fs.writeFile(target, file.buffer, { flag: 'wx' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new ConflictException(
          `A document named "${name}" already exists in this bucket`,
        );
      }
      throw new BadRequestException(
        `Cannot store document: ${(err as Error).message}`,
      );
    }
    try {
      return await this.prisma.managedDocument.create({
        data: {
          bucketId,
          name,
          kind,
          mimeType,
          sizeBytes: file.buffer.length,
        },
      });
    } catch (err) {
      await fs.unlink(target).catch(() => undefined);
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `A document named "${name}" already exists in this bucket`,
        );
      }
      throw err;
    }
  }

  /** Resolve a document's stored file for download. */
  async resolveDownload(
    bucketId: string,
    documentId: string,
  ): Promise<{
    target: string;
    fileName: string;
    mimeType: string;
    size: number;
  }> {
    const doc = await this.prisma.managedDocument.findFirst({
      where: { id: documentId, bucketId },
    });
    if (!doc)
      throw new NotFoundException(
        `Document ${documentId} not found in this bucket`,
      );
    const bucket = await this.getBucket(bucketId);
    const target = path.join(
      await this.resolveMappedRoot(
        bucket.folderType as 'project' | 'agent',
        bucket.folderName,
      ),
      bucket.name,
      doc.name,
    );
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) {
      throw new NotFoundException('Stored document file is missing');
    }
    return {
      target,
      fileName: doc.name,
      mimeType: doc.mimeType ?? 'application/octet-stream',
      size: stat.size,
    };
  }

  /* ----------------------------- internals ----------------------------- */

  /** Resolve the mapped project/agent folder root and validate it exists. */
  private async resolveMappedRoot(
    folderType: 'project' | 'agent',
    folderName: string,
  ): Promise<string> {
    if (folderType === 'agent') {
      this.workspaces.assertAgentName(folderName);
      return this.workspaces.getAgentRoot(folderName);
    }
    const safe = this.workspaces.sanitizeName(folderName);
    const dir = path.join(this.workspaces.getProjectRoot(), safe);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      throw new BadRequestException(`Project folder "${safe}" does not exist`);
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException(`Project path "${safe}" is not a folder`);
    }
    return dir;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}
