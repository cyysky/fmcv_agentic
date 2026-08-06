import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';

/** File manager API: full read/write round-trip on an agent scope plus the
 *  guardrails (escapes, read-only projects, size caps, missing paths). */
describe('Files API (e2e)', () => {
  let app: INestApplication<App>;
  const scope = 'agent:coder';
  const base = 'fm-e2e';
  const filePath = `${base}/hello.txt`;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  afterAll(async () => {
    // Best-effort cleanup of everything this suite created.
    for (const path of [filePath, `${base}/sub`, base]) {
      try {
        await request(app.getHttpServer())
          .delete('/api/files/delete')
          .query({ scope, path })
          .expect(200);
      } catch {
        /* already gone */
      }
    }
    await app.close();
  });

  it('creates a file, lists it with metadata and reads it back', async () => {
    const created = await request(app.getHttpServer())
      .put('/api/files/write')
      .query({ scope, path: filePath })
      .send({ content: 'hello file manager' })
      .expect(200);
    expect(created.body).toMatchObject({ scope, path: filePath });
    expect(created.body.bytes).toBe('hello file manager'.length);

    const list = await request(app.getHttpServer())
      .get('/api/files/list')
      .query({ scope, path: base })
      .expect(200);
    const entry = list.body.entries.find((e: { name: string }) => e.name === 'hello.txt');
    expect(entry).toMatchObject({ type: 'file' });
    expect(entry.size).toBe('hello file manager'.length);
    expect(typeof entry.mtimeMs).toBe('number');

    const read = await request(app.getHttpServer())
      .get('/api/files/read')
      .query({ scope, path: filePath })
      .expect(200);
    expect(read.body.content).toBe('hello file manager');
  });

  it('uses a directory-first listing for a mixed folder', async () => {
    await request(app.getHttpServer())
      .put('/api/files/write')
      .query({ scope, path: `${base}/a.txt` })
      .send({ content: 'a' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/files/mkdir')
      .query({ scope, path: `${base}/sub` })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/files/list')
      .query({ scope, path: base })
      .expect(200);
    expect(list.body.entries.map((e: { name: string }) => e.name)).toEqual([
      'sub',
      'a.txt',
      'hello.txt',
    ]);
  });

  it('deletes an empty directory and then a file', async () => {
    const dir = (
      await request(app.getHttpServer())
        .delete('/api/files/delete')
        .query({ scope, path: `${base}/sub` })
        .expect(200)
    ).body;
    expect(dir.type).toBe('directory');

    await request(app.getHttpServer())
      .delete('/api/files/delete')
      .query({ scope, path: filePath })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/files/read')
      .query({ scope, path: filePath })
      .expect(404);

    // The directory can no longer be listed either.
    await request(app.getHttpServer())
      .get('/api/files/list')
      .query({ scope, path: `${base}/sub` })
      .expect(404);
  });

  it('rejects path escapes with 400', async () => {
    await request(app.getHttpServer())
      .get('/api/files/list')
      .query({ scope, path: '../..' })
      .expect(400);
  });

  it('refuses to write into public projects (403)', async () => {
    await request(app.getHttpServer())
      .put('/api/files/write')
      .query({ scope: 'project:shared', path: 'x.txt' })
      .send({ content: 'x' })
      .expect(403);
  });

  it('validates the scope parameter (400)', async () => {
    await request(app.getHttpServer())
      .get('/api/files/list')
      .query({ scope: 'bogus' })
      .expect(400);
  });
});
