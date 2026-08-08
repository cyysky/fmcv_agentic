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
  const htmlPath = `${base}/view.html`;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  afterAll(async () => {
    // Best-effort cleanup of everything this suite created.
    for (const path of [
      filePath,
      htmlPath,
      `${base}/blob.bin`,
      `${base}/sub`,
      base,
    ]) {
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
    const entry = list.body.entries.find(
      (e: { name: string }) => e.name === 'hello.txt',
    );
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

  it('streams a downloadable text file with attachment headers', async () => {
    const dl = await request(app.getHttpServer())
      .get('/api/files/download')
      .query({ scope, path: filePath })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(dl.headers['content-disposition']).toContain(
      'attachment; filename="hello.txt"',
    );
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(Number(dl.headers['content-length'])).toBe(
      'hello file manager'.length,
    );
    expect((dl.body as Buffer).toString('utf8')).toBe('hello file manager');
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

  it('downloads binary files byte-for-byte', async () => {
    const binPath = `${base}/blob.bin`;
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x0a, 0x0d]);
    const wsRoot = (process.env.AGENT_WORKSPACE_ROOT ?? '').replace(/\/$/, '');
    const target = require('node:path').join(
      wsRoot,
      'agents',
      'coder',
      binPath,
    );
    const { mkdir, writeFile } = require('node:fs/promises');
    await mkdir(require('node:path').dirname(target), { recursive: true });
    await writeFile(target, bytes);

    const dl = await request(app.getHttpServer())
      .get('/api/files/download')
      .query({ scope, path: binPath })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(dl.headers['content-disposition']).toContain(
      'attachment; filename="blob.bin"',
    );
    expect(Buffer.compare(dl.body as Buffer, bytes)).toBe(0);
  });

  it('refuses to download a directory or an escaped path', async () => {
    await request(app.getHttpServer())
      .get('/api/files/download')
      .query({ scope, path: base })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/files/download')
      .query({ scope, path: '../../etc/passwd' })
      .expect(400);
  });

  it('serves an HTML file inline with sandboxed text/html headers', async () => {
    const html = '<!doctype html><html><body><h1>html e2e</h1></body></html>';
    await request(app.getHttpServer())
      .put('/api/files/write')
      .query({ scope, path: htmlPath })
      .send({ content: html })
      .expect(200);

    const view = await request(app.getHttpServer())
      .get('/api/files/view')
      .query({ scope, path: htmlPath })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(view.headers['content-type']).toContain('text/html');
    expect(view.headers['content-disposition']).toContain(
      'inline; filename="view.html"',
    );
    expect(view.headers['content-security-policy']).toBe('sandbox');
    expect(view.headers['x-content-type-options']).toBe('nosniff');
    expect(view.headers['cache-control']).toContain('no-store');
    expect((view.body as Buffer).toString('utf8')).toBe(html);
  });

  it('refuses to view non-HTML files inline (415)', async () => {
    const plainPath = `${base}/plain.txt`;
    await request(app.getHttpServer())
      .put('/api/files/write')
      .query({ scope, path: plainPath })
      .send({ content: 'plain text' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/files/view')
      .query({ scope, path: plainPath })
      .expect(415);
  });

  it('refuses to view directories or empty paths inline (400)', async () => {
    await request(app.getHttpServer())
      .get('/api/files/view')
      .query({ scope, path: base })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/files/view')
      .query({ scope, path: '' })
      .expect(400);
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
