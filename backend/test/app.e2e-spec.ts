import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/** Boot the app exactly like `main.ts`: global `/api` prefix + the same
 *  ValidationPipe (whitelist, forbidNonWhitelisted, transform). The previous
 *  boilerplate skipped these, so it missed the real API surface. */
export async function bootstrapApp(): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}

describe('App API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api — app root responds', () => {
    return request(app.getHttpServer()).get('/api').expect(200).expect('Hello World!');
  });

  it('GET /api/agent/models — catalog of known models', async () => {
    const res = await request(app.getHttpServer()).get('/api/agent/models').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((m: { id: string }) => m.id);
    expect(ids).toContain('ds4-flash');
  });

  it('GET /api/agent/workspaces — lists projects and named agents', async () => {
    const res = await request(app.getHttpServer()).get('/api/agent/workspaces').expect(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    const agentNames = res.body.agents.map((a: { name: string }) => a.name);
    expect(agentNames).toEqual(expect.arrayContaining(['coder', 'researcher']));
  });

  it('rejects unknown body properties at the API boundary', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agent/workspaces/projects')
      .send({ name: 'valid-project', whatever: true })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('whatever');
  });

  it('validates workspace project names (alphanumeric, dash, underscore)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agent/workspaces/projects')
      .send({ name: 'bad name!' })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('alphanumeric');
  });
});
