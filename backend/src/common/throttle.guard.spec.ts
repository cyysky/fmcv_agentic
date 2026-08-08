import { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerException } from '@nestjs/throttler';
import { TestingModule } from '@nestjs/testing';
import { AppThrottlerGuard, envPositiveInt } from './throttle.guard';

function contextAt(ip = '1.2.3.4') {
  return {
    getHandler: () => () => undefined,
    getClass: () => class StubController {},
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {} }),
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('AppThrottlerGuard', () => {
  let guard: AppThrottlerGuard;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            ttl: () => envPositiveInt('RATE_LIMIT_TTL_MS', 60_000),
            limit: () => envPositiveInt('RATE_LIMIT_MAX', 100),
          },
        ]),
      ],
      providers: [AppThrottlerGuard],
    }).compile();
    guard = moduleRef.get(AppThrottlerGuard);
    await guard.onModuleInit();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_TTL_MS;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('defaults are generous enough for a local burst (fail open)', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(contextAt('10.0.0.1'))).resolves.toBe(
        true,
      );
    }
  });

  it('rejects requests beyond a tiny limit (429 semantics)', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TTL_MS = '1000';
    const ctx = contextAt('10.0.0.2');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ThrottlerException);
  });

  it('recovers once the window expires', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TTL_MS = '80';
    const ctx = contextAt('10.0.0.3');
    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ThrottlerException);
    await new Promise((resolve) => setTimeout(resolve, 130));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('RATE_LIMIT_MAX=0 disables throttling entirely', async () => {
    process.env.RATE_LIMIT_MAX = '0';
    for (let i = 0; i < 10; i++) {
      await expect(guard.canActivate(contextAt('10.0.0.4'))).resolves.toBe(
        true,
      );
    }
  });

  it('reads limits per request, so env changes apply without a reboot', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TTL_MS = '1000';
    const ctx = contextAt('10.0.0.5');
    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ThrottlerException);
    process.env.RATE_LIMIT_MAX = '100';
    // A fresh client immediately sees the raised limit...
    await expect(guard.canActivate(contextAt('10.0.0.6'))).resolves.toBe(true);
    // ...while the already-blocked key stays blocked for its window...
    await expect(guard.canActivate(ctx)).rejects.toThrow(ThrottlerException);
    // ...and recovers once that window elapses.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
