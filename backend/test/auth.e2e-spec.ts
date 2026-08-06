import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';

describe('API token gate (e2e, real Postgres)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.API_TOKEN = 'e2e-api-token';
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.API_TOKEN;
  });

  it('rejects unauthenticated reads and mutations with 401', async () => {
    await http().get('/api/agent/models').expect(401);
    await http().get('/api/connections').expect(401);
    await http().post('/api/connections').send({ displayName: 'x' }).expect(401);
    await http().post('/api/agent/turn').send({ message: 'hi' }).expect(401);
  });

  it('rejects a wrong bearer token', async () => {
    await http()
      .get('/api/agent/models')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
  });

  it('accepts the configured token for reads and mutations', async () => {
    const auth = { Authorization: 'Bearer e2e-api-token' };
    await http().get('/api/agent/models').set(auth).expect(200);

    const created = await http()
      .post('/api/connections')
      .set(auth)
      .send({
        displayName: `auth-e2e-${Date.now().toString(36)}`,
        baseUrl: 'http://127.0.0.1:9/v1/',
        modelName: 'ds4-flash',
        contextLength: 131000,
      })
      .expect(201);
    await http().delete(`/api/connections/${created.body.id}`).set(auth).expect(200);
  });
});
