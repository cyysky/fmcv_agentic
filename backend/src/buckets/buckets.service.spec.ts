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
function prismaDouble(): {
  bucket: MockStore;
  managedDocument: MockStore;
  $transaction: jest.Mock;
} {
  const make = (defaultValue: unknown): MockStore => ({
    create: jest.fn().mockResolvedValue(defaultValue),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(defaultValue),
    delete: jest.fn().mockResolvedValue(defaultValue),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  });
  return {
    bucket: make({ id: 'bucket-1' }),
    managedDocument: make({ id: 'doc-1' }),
    $transaction: jest
      .fn()
      .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
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

  it('renames a bucket and moves its folder on disk', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    (prisma.bucket.update as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research-renamed',
      folderType: 'project',
      folderName: 'docs',
    });
    const oldDir = path.join(root, 'projects', 'docs', 'research');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'paper.pdf'), 'x');

    const renamed = await service.renameBucket('bucket-1', 'research-renamed');

    expect(renamed.name).toBe('research-renamed');
    expect(prisma.bucket.update).toHaveBeenCalledWith({
      where: { id: 'bucket-1' },
      data: { name: 'research-renamed' },
    });
    await expect(fs.stat(oldDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const moved = await fs.stat(
      path.join(root, 'projects', 'docs', 'research-renamed'),
    );
    expect(moved.isDirectory()).toBe(true);
    expect(
      await fs.readFile(
        path.join(root, 'projects', 'docs', 'research-renamed', 'paper.pdf'),
        'utf8',
      ),
    ).toBe('x');
  });

  it('recreates the folder when a renamed bucket row has no folder', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'ghost',
      folderType: 'project',
      folderName: 'docs',
    });
    (prisma.bucket.update as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'ghost-fixed',
      folderType: 'project',
      folderName: 'docs',
    });
    const renamed = await service.renameBucket('bucket-1', 'ghost-fixed');
    expect(renamed.name).toBe('ghost-fixed');
    const stat = await fs.stat(
      path.join(root, 'projects', 'docs', 'ghost-fixed'),
    );
    expect(stat.isDirectory()).toBe(true);
  });

  it('renaming to the current name is an idempotent no-op', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const out = await service.renameBucket('bucket-1', 'research');
    expect(out.name).toBe('research');
    expect(prisma.bucket.update).not.toHaveBeenCalled();
  });

  it('409s when the new bucket name already exists', async () => {
    (prisma.bucket.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'bucket-1',
        name: 'research',
        folderType: 'project',
        folderName: 'docs',
      })
      .mockResolvedValueOnce({
        id: 'bucket-2',
        name: 'taken',
        folderType: 'project',
        folderName: 'docs',
      });
    await expect(
      service.renameBucket('bucket-1', 'taken'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s when the target folder already exists on disk', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await fs.mkdir(path.join(root, 'projects', 'docs', 'research-renamed'), {
      recursive: true,
    });
    await expect(
      service.renameBucket('bucket-1', 'research-renamed'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a rename that escapes the mapped root', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await expect(
      service.renameBucket('bucket-1', '../../evil'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes a bucket: removes its folder and both row types', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const bucketDir = path.join(root, 'projects', 'docs', 'research');
    await fs.mkdir(bucketDir, { recursive: true });
    await fs.writeFile(path.join(bucketDir, 'paper.pdf'), 'x');

    await expect(service.deleteBucket('bucket-1')).resolves.toEqual({
      deleted: true,
    });
    expect(prisma.managedDocument.deleteMany).toHaveBeenCalledWith({
      where: { bucketId: 'bucket-1' },
    });
    expect(prisma.bucket.delete).toHaveBeenCalledWith({
      where: { id: 'bucket-1' },
    });
    await expect(fs.stat(bucketDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delete 404s for an unknown bucket and touches no rows', async () => {
    await expect(service.deleteBucket('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.bucket.delete).not.toHaveBeenCalled();
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
