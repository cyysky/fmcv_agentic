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

  it('caps long upload names and falls back to "document"', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const longName = 'a'.repeat(190) + '.txt';
    await service.addDocument('bucket-1', {
      originalname: longName,
      buffer: Buffer.from('x'),
    });
    const cappedName = (prisma.managedDocument.create as jest.Mock).mock
      .calls[0][0].data.name as string;
    expect(cappedName).toHaveLength(180);
    expect(cappedName.endsWith('.txt')).toBe(true);

    // An empty/undefined name is replaced.
    await service.addDocument('bucket-1', {
      originalname: '',
      buffer: Buffer.from('y'),
    });
    const fallbackName = (prisma.managedDocument.create as jest.Mock).mock
      .calls[1][0].data.name as string;
    expect(fallbackName).toBe('document');
  });

  it('rejects an upload with no usable buffer', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await expect(
      service.addDocument('bucket-1', { originalname: 'x.txt' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listDocuments checks the bucket then delegates to findMany', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    await service.listDocuments('bucket-1');
    expect(prisma.managedDocument.findMany).toHaveBeenCalledWith({
      where: { bucketId: 'bucket-1' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('wraps bucket-folder creation failures as BadRequest', async () => {
    // A file squatting on the bucket name makes fs.mkdir fail.
    await fs.writeFile(path.join(root, 'agents', 'coder', 'occupied'), 'x');
    await expect(
      service.createBucket({
        name: 'occupied',
        folderType: 'agent',
        folderName: 'coder',
      }),
    ).rejects.toThrow('Cannot create bucket folder');
  });

  it('rethrows a non-unique DB error and rolls back the folder', async () => {
    (prisma.bucket.create as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      service.createBucket({
        name: 'transient',
        folderType: 'agent',
        folderName: 'coder',
      }),
    ).rejects.toThrow('db down');
    await expect(
      fs.stat(path.join(root, 'agents', 'coder', 'transient')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolveDownload 404s when the document is not in the bucket', async () => {
    await expect(
      service.resolveDownload('bucket-1', 'doc-missing'),
    ).rejects.toThrow('not found in this bucket');
  });

  it('resolveDownload returns stored file metadata with a mime fallback', async () => {
    (prisma.managedDocument.findFirst as jest.Mock).mockResolvedValue({
      id: 'doc-1',
      bucketId: 'bucket-1',
      name: 'paper.pdf',
      mimeType: null,
    });
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const target = path.join(root, 'projects', 'docs', 'research', 'paper.pdf');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '%PDF fake');

    const out = await service.resolveDownload('bucket-1', 'doc-1');
    expect(out.target).toBe(target);
    expect(out.fileName).toBe('paper.pdf');
    expect(out.mimeType).toBe('application/octet-stream');
    expect(out.size).toBe(9);
  });

  it('treats a non-ENOENT stat on the rename target as BadRequest', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    // A file squatting on an ancestor path yields ENOTDIR from fs.stat.
    await fs.writeFile(path.join(root, 'projects', 'docs', 'blocked'), 'x');
    await expect(
      service.renameBucket('bucket-1', 'blocked/child'),
    ).rejects.toThrow('Cannot inspect target folder');
  });

  it('maps ENOTEMPTY during the folder move to ConflictException', async () => {
    (prisma.bucket.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'bucket-1',
        name: 'research',
        folderType: 'project',
        folderName: 'docs',
      })
      .mockResolvedValueOnce(null);
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(
        Object.assign(new Error('target not empty'), { code: 'ENOTEMPTY' }),
      );
    try {
      await expect(
        service.renameBucket('bucket-1', 'enotempty-target'),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('rolls the folder back when the rename DB update fails', async () => {
    (prisma.bucket.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'bucket-1',
        name: 'research',
        folderType: 'project',
        folderName: 'docs',
      })
      .mockResolvedValueOnce(null);
    (prisma.bucket.update as jest.Mock).mockRejectedValueOnce(
      uniqueViolation(),
    );
    const oldDir = path.join(root, 'projects', 'docs', 'research');
    await fs.mkdir(oldDir, { recursive: true });

    await expect(
      service.renameBucket('bucket-1', 'rollback-target'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      fs.stat(path.join(root, 'projects', 'docs', 'rollback-target')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(oldDir)).isDirectory()).toBe(true);

    // A generic DB error follows the same rollback and becomes BadRequest.
    (prisma.bucket.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'bucket-1',
        name: 'research',
        folderType: 'project',
        folderName: 'docs',
      })
      .mockResolvedValueOnce(null);
    (prisma.bucket.update as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await fs.mkdir(path.join(root, 'projects', 'docs', 'generic-move'), {
      recursive: true,
    });
    const genericOld = path.join(root, 'projects', 'docs', 'generic-move');
    const genericNew = path.join(root, 'projects', 'docs', 'generic-moved');
    await fs.rename(genericOld, genericNew);
    // Point the row at the now-moved folder name.
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'bucket-2',
      name: 'generic-moved',
      folderType: 'project',
      folderName: 'docs',
    });
    await expect(
      service.renameBucket('bucket-2', 'generic-moved-2'),
    ).rejects.toThrow('db down');
    await expect(fs.stat(genericNew)).resolves.toBeDefined();
  });

  it('wraps bucket-folder removal failures as BadRequest', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const rmSpy = jest
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'EBUSY' }),
      );
    try {
      await expect(service.deleteBucket('bucket-1')).rejects.toThrow(
        'Cannot remove bucket folder',
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('restores the folder when the delete transaction fails', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    const bucketDir = path.join(root, 'projects', 'docs', 'research');
    await fs.mkdir(bucketDir, { recursive: true });

    await expect(service.deleteBucket('bucket-1')).rejects.toThrow('db down');
    expect((await fs.stat(bucketDir)).isDirectory()).toBe(true);
  });

  it('rolls the uploaded file back when the document row create fails', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });

    // Unique-violation on create: Conflict, file removed.
    (prisma.managedDocument.create as jest.Mock).mockRejectedValueOnce(
      uniqueViolation(),
    );
    await expect(
      service.addDocument('bucket-1', {
        originalname: 'dbdup.txt',
        buffer: Buffer.from('x'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      fs.stat(path.join(root, 'projects', 'docs', 'research', 'dbdup.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // Generic create failure: rethrown, file removed.
    (prisma.managedDocument.create as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      service.addDocument('bucket-1', {
        originalname: 'dbfail.txt',
        buffer: Buffer.from('y'),
      }),
    ).rejects.toThrow('db down');
    await expect(
      fs.stat(path.join(root, 'projects', 'docs', 'research', 'dbfail.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a project folder path that is a file, not a folder', async () => {
    await fs.writeFile(path.join(root, 'projects', 'fileblock'), 'x');
    await expect(
      service.createBucket({
        name: 'under-file',
        folderType: 'project',
        folderName: 'fileblock',
      }),
    ).rejects.toThrow('is not a folder');
  });

  it('wraps a non-EEXIST file-store failure as BadRequest', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const bucketDir = path.join(root, 'projects', 'docs', 'research');
    await fs.mkdir(bucketDir, { recursive: true });
    try {
      await fs.chmod(bucketDir, 0o555);
      await expect(
        service.addDocument('bucket-1', {
          originalname: 'blocked.txt',
          buffer: Buffer.from('x'),
        }),
      ).rejects.toThrow('Cannot store document');
    } finally {
      await fs.chmod(bucketDir, 0o755);
    }
  });

  it('rethrows a non-EEXIST/-ENOTEMPTY folder-move failure', async () => {
    (prisma.bucket.findUnique as jest.Mock).mockResolvedValue({
      id: 'bucket-1',
      name: 'research',
      folderType: 'project',
      folderName: 'docs',
    });
    const mappedRoot = path.join(root, 'projects', 'docs');
    const oldDir = path.join(mappedRoot, 'research');
    await fs.mkdir(oldDir, { recursive: true });
    try {
      await fs.chmod(mappedRoot, 0o555);
      await expect(
        service.renameBucket('bucket-1', 'chmod-block'),
      ).rejects.toThrow('EACCES');
    } finally {
      await fs.chmod(mappedRoot, 0o755);
    }
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
