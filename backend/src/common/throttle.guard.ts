import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Parse a positive integer env var; invalid/empty values fall back. */
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Global per-IP request throttler (wired via APP_GUARD + ThrottlerModule).
 *
 * - `RATE_LIMIT_MAX` (default 100): max requests per window per client IP.
 *   `0` disables throttling entirely, keeping local dev fail-open.
 * - `RATE_LIMIT_TTL_MS` (default 60000): window length in milliseconds.
 *
 * Limits are read per request (like ApiTokenGuard), so tests and operators
 * can change the env values without rebooting the app.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const raw = process.env.RATE_LIMIT_MAX;
    const max = raw ? Number.parseInt(raw, 10) : 100;
    if (Number.isFinite(max) && max <= 0) return true;
    return super.canActivate(context);
  }
}
