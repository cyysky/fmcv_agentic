import { ApiTokenGuard } from './api-token.guard';
import { UnauthorizedException } from '@nestjs/common';

function contextWith(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as never;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('ApiTokenGuard', () => {
  afterEach(() => {
    delete process.env.API_TOKEN;
  });

  it('allows everything when API_TOKEN is not configured (fail open)', () => {
    const guard = new ApiTokenGuard();
    expect(guard.canActivate(contextWith())).toBe(true);
    expect(guard.canActivate(contextWith('Bearer whatever'))).toBe(true);
  });

  it('rejects missing or malformed credentials when a token is set', () => {
    process.env.API_TOKEN = 's3cret';
    const guard = new ApiTokenGuard();
    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextWith('Token s3cret'))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextWith('Bearer wrong-token'))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextWith('Bearer'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the matching bearer token', () => {
    process.env.API_TOKEN = 's3cret';
    const guard = new ApiTokenGuard();
    expect(guard.canActivate(contextWith('Bearer s3cret'))).toBe(true);
  });
});
