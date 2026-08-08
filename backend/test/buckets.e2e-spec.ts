import { INestApplication } from '@nestjs/common';
import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapApp } from './test-app';

interface BucketDocument {
  id: string;
  name: string;
  kind: string;
  mimeType?: string;
  sizeBytes?: number;
}

interface BucketRow {
  id: string;
  name: string;
  folderType: string;
  folderName: string;
  documents?: BucketDocument[];
  _count?: { documents: number };
}

/** supertest responses carry an `any` body; cast it through an explicit
 *  interface so the spec stays type-safe without `no-unsafe-*` hits. */
interface TypedResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
const json = <T>(res: TypedResponse): T => res.body as T;

describe('Buckets API (e2e, real Postgres + temp workspace)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const stamp = Date.now().toString(36);
  const bucketName = `e2e-bucket-${stamp}`;
  const projectName = `e2e-proj-${stamp}`;
  let bucketId = '';
  let docId = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapApp();
    prisma = app.get(PrismaService);
    // Public project folders are the only project targets buckets may map to.
    await http()
      .post('/api/agent/workspaces/projects')
      .send({ name: projectName })
      .expect(201);
  });

  afterAll(async () => {
    if (bucketId) {
      await prisma.managedDocument.deleteMany({ where: { bucketId } });
      await prisma.bucket.deleteMany({ where: { id: bucketId } });
    }
    // The bucket folder lives under the temp E2E workspace; remove it so the
    // next run starts clean even if a test failed mid-way.
    const root = process.env.AGENT_WORKSPACE_ROOT ?? '';
    const bucketDir = path.join(root, 'projects', projectName, bucketName);
    await fs
      .rm(bucketDir, { recursive: true, force: true })
      .catch(() => undefined);
    await app.close();
  });

  it('creates a unique bucket mapped to a project folder', async () => {
    const res = await http()
      .post('/api/buckets')
      .send({
        name: bucketName,
        folderType: 'project',
        folderName: projectName,
      })
      .expect(201);
    const created = json<BucketRow>(res);
    expect(created).toMatchObject({
      name: bucketName,
      folderType: 'project',
      folderName: projectName,
    });
    bucketId = created.id;
    expect(bucketId).toBeTruthy();
  });

  it('409s on a duplicate bucket name', async () => {
    await http()
      .post('/api/buckets')
      .send({
        name: bucketName,
        folderType: 'project',
        folderName: projectName,
      })
      .expect(409);
  });

  it('400s on an invalid folderType', async () => {
    await http()
      .post('/api/buckets')
      .send({
        name: `bad-type-${stamp}`,
        folderType: 'shared',
        folderName: projectName,
      })
      .expect(400);
  });

  it('400s when the project folder does not exist', async () => {
    await http()
      .post('/api/buckets')
      .send({
        name: `ghost-${stamp}`,
        folderType: 'project',
        folderName: 'missing-proj',
      })
      .expect(400);
  });

  it('400s for an unknown agent folder', async () => {
    await http()
      .post('/api/buckets')
      .send({
        name: `ghost-agent-${stamp}`,
        folderType: 'agent',
        folderName: 'nobody',
      })
      .expect(400);
  });

  it('lists buckets with a document count', async () => {
    const res = await http().get('/api/buckets').expect(200);
    const rows = json<BucketRow[]>(res);
    const row = rows.find((b) => b.id === bucketId);
    expect(row).toBeTruthy();
    expect(row?._count).toEqual({ documents: 0 });
  });

  it('gets one bucket with an empty documents list', async () => {
    const res = await http().get(`/api/buckets/${bucketId}`).expect(200);
    const row = json<BucketRow>(res);
    expect(row.name).toBe(bucketName);
    expect(row.documents).toEqual([]);
  });

  it('404s for an unknown bucket', async () => {
    await http()
      .get('/api/buckets/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('uploads a managed PDF document into the bucket', async () => {
    const res = await http()
      .post(`/api/buckets/${bucketId}/documents`)
      .attach('file', Buffer.from('%PDF-1.7 fake e2e payload'), {
        filename: 'spec.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const created = json<BucketDocument>(res);
    expect(created).toMatchObject({
      bucketId,
      name: 'spec.pdf',
      kind: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: Buffer.from('%PDF-1.7 fake e2e payload').length,
    });
    docId = created.id;
  });

  it('409s when a document name is uploaded twice', async () => {
    await http()
      .post(`/api/buckets/${bucketId}/documents`)
      .attach('file', Buffer.from('duplicate'), {
        filename: 'spec.pdf',
        contentType: 'application/pdf',
      })
      .expect(409);
  });

  it('400s when the multipart file field is missing', async () => {
    await http()
      .post(`/api/buckets/${bucketId}/documents`)
      .send({ unrelated: true })
      .expect(400);
  });

  it('lists documents after the upload', async () => {
    const res = await http()
      .get(`/api/buckets/${bucketId}/documents`)
      .expect(200);
    const rows = json<BucketDocument[]>(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: docId,
      name: 'spec.pdf',
      kind: 'pdf',
    });
  });

  it('downloads the document with the stored bytes and attachment headers', async () => {
    const res = await http()
      .get(`/api/buckets/${bucketId}/documents/${docId}/download`)
      .expect(200)
      .expect('Content-Type', 'application/pdf');
    expect(String(res.headers['content-disposition'] ?? '')).toMatch(
      /attachment; filename="spec\.pdf"/,
    );
    expect(String(res.body)).toContain('%PDF-1.7 fake e2e payload');
  });

  it('404s downloading a document that is not in the bucket', async () => {
    await http()
      .get(
        `/api/buckets/${bucketId}/documents/00000000-0000-4000-8000-000000000000/download`,
      )
      .expect(404);
  });
});
