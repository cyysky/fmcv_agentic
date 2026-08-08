import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceService } from '../agent/workspace.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BucketsService,
  deriveDocumentKind,
  MAX_BUCKET_FILE_BYTES,
} from './buckets.service';

/** Minimal Prisma double for the two models the buckets service touches. */
type MockStore = Record<string, jest.Mock>;
function prismaDouble(): { bucket: MockStore; managedDocument: MockStore } {
  const make = (defaultValue: unknown): MockStore => ({
    create: jest.fn().mockResolvedValue(defaultValue),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
  });
  return {
    bucket: make({ id: 'bucket-1' }),
    managedDocument: make({ id: 'doc-1' }),
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('unique constraint', {
    code: 'P2002',
    clientVersion: 'x',
  });
}

/** A real WorkspaceService rooted in a throwaway temp dir. */
function workspaceAt(root: string): WorkspaceService {
  return new WorkspaceService({
    get: (key: string, fallback?: string) =>
      key === 'AGENT_WORKSPACE_ROOT' ? root : fallback,
  } as unknown as ConfigService);
}

describe('BucketsService', () => {
  let root = '';
  let service: BucketsService;
  let prisma: ReturnType<typeof prismaDouble>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-buckets-spec-'));
    const projectRoot = path.join(root, 'projects');
    await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    prisma = prismaDouble();
    service = new BucketsService(
      prisma as unknown as PrismaService,
      workspaceAt(root),
    );
  });

  it('creates a bucket inside a named agent folder', async () => {
    const created = await service.createBucket({
      name: 'agent-bucket',
      folderType: 'agent',
      folderName: 'coder',
    });
    expect(created.id).toBe('bucket-1');
    expect(prisma.bucket.create).toHaveBeenCalledWith({
      data: {
        name: 'agent-bucket',
        folderType: 'agent',
        folderName: 'coder',
      },
    });
    const stat = await fs.stat(
      path.join(root, 'agents', 'coder', 'agent-bucket'),
    );
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates a bucket inside an existing project folder', async () => {
    await service.createBucket({
      name: 'project-bucket',
      folderType: 'project',
      folderName: 'docs',
    });
    const stat = await fs.stat(
      path.join(root, 'projects', 'docs', 'project-bucket'),
    );
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects a project folder that does not exist', async () => {
    await expect(
      service.createBucket({
        name: 'ghost-bucket',
        folderType: 'project',
        folderName: 'missing',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown agent folder', async () => {
    await expect(
      service.createBucket({
        name: 'ghost-bucket',
        folderType: 'agent',
        folderName: 'nobody',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409s when the bucket name is already taken', async () => {
    (prisma.bucket.create as jest.Mock).mockRejectedValueOnce(
      uniqueViolation(),
    );
    await expect(
      service.createBucket({
        name: 'dupe',
        folderType: 'agent',
        folderName: 'coder',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists buckets with document counts', async () => {
    await service.listBuckets();
    expect(prisma.bucket.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { documents: true } } },
    });
  });

  it('404s for an unknown bucket', async () => {
    await expect(service.getBucket('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('stores an uploaded document exactly once and derives its kind', async () => {
    const bucket = {
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    };
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue(bucket);
    (prisma.managedDocument.create as jest.Mock).mockResolvedValue({
      id: 'doc-1',
      bucketId: 'bucket-1',
      name: 'paper.pdf',
      kind: 'pdf',
    });
    const file = {
      originalname: 'paper.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 fake'),
    };
    const doc = await service.addDocument('bucket-1', file);
    expect(doc.kind).toBe('pdf');
    expect(prisma.managedDocument.create).toHaveBeenCalledWith({
      data: {
        bucketId: 'bucket-1',
        name: 'paper.pdf',
        kind: 'pdf',
        mimeType: 'application/pdf',
        sizeBytes: file.buffer.length,
      },
    });
    const stored = await fs.readFile(
      path.join(root, 'projects', 'docs', 'research', 'paper.pdf'),
      'utf8',
    );
    expect(stored).toBe('%PDF-1.7 fake');
  });

  it('rejects an empty upload', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await expect(
      service.addDocument('bucket-1', {
        originalname: 'empty.txt',
        buffer: Buffer.alloc(0),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an oversize upload', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await expect(
      service.addDocument('bucket-1', {
        originalname: 'big.bin',
        buffer: Buffer.alloc(MAX_BUCKET_FILE_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409s when the file name already exists in the bucket (no overwrite)', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await service.addDocument('bucket-1', {
      originalname: 'twice.txt',
      buffer: Buffer.from('a'),
    });
    await expect(
      service.addDocument('bucket-1', {
        originalname: 'twice.txt',
        buffer: Buffer.from('b'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('neutralizes path traversal in uploaded names', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await service.addDocument('bucket-1', {
      originalname: '../../evil.txt',
      buffer: Buffer.from('x'),
    });
    const stored = await fs.stat(
      path.join(root, 'projects', 'docs', 'research', 'evil.txt'),
    );
    expect(stored.isFile()).toBe(true);
  });

  it('404s when the stored file is missing at download time', async () => {
    (prisma.managedDocument.findFirst as jest.Mock).mockResolvedValue({
      id: 'doc-1',
      bucketId: 'bucket-1',
      name: 'gone.pdf',
      mimeType: 'application/pdf',
    });
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await expect(
      service.resolveDownload('bucket-1', 'doc-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('deriveDocumentKind', () => {
  it.each([
    ['application/pdf', 'a.pdf', 'pdf'],
    ['text/plain', 'notes.txt', 'text'],
    ['video/mp4', 'clip.mp4', 'video'],
    ['audio/mpeg', 'podcast.mp3', 'audio'],
    ['application/octet-stream', 'archive.zip', 'other'],
  ])('maps %s %s -> %s', (mime, name, expected) => {
    expect(deriveDocumentKind(mime, name)).toBe(expected);
  });
});
