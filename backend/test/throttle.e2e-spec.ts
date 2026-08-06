import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';

/**
 * Dedicated low-limit instance: the global guard is env-driven per request,
 * so this file boots its own app with a tiny limit and never disturbs the
 * other suites (env is restored afterwards for runInBand safety).
 */
describe('Throttling (e2e)', () => {
  let app: INestApplication<App>;
  const previous = {
    max: process.env.RATE_LIMIT_MAX,
    ttl: process.env.RATE_LIMIT_TTL_MS,
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TTL_MS = '1000';
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app.close();
    if (previous.max === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previous.max;
    if (previous.ttl === undefined) delete process.env.RATE_LIMIT_TTL_MS;
    else process.env.RATE_LIMIT_TTL_MS = previous.ttl;
  });

  it('allows requests up to the limit and 429s the over-limit burst', async () => {
    const first = await request(app.getHttpServer())
      .get('/api/agent/models')
      .expect(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');

    const second = await request(app.getHttpServer())
      .get('/api/agent/models')
      .expect(200);
    expect(Number(second.headers['x-ratelimit-remaining'])).toBe(0);

    const blocked = await request(app.getHttpServer())
      .get('/api/agent/models')
      .expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('recovers after the throttling window elapses', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request(app.getHttpServer()).get('/api/agent/models').expect(200);
  });
});
