import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Optional request-token gate for the whole /api surface.
 *
 * - `API_TOKEN` unset/empty (local dev default): all requests pass.
 * - `API_TOKEN` set: every request must carry
 *   `Authorization: Bearer <token>`; anything else gets 401.
 *
 * The token is read per-request (not at construction) so tests can toggle
 * the env value freely. Note this is defense-in-depth for LAN/dev usage, not
 * a full auth system: a token shipped to a browser is not a secret.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.API_TOKEN ?? '';
    if (!token) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    const provided = match?.[1]?.trim() ?? '';
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    const ok =
      a.length === b.length && provided.length > 0 && timingSafeEqual(a, b);
    if (!ok) {
      throw new UnauthorizedException('Missing or invalid API token');
    }
    return true;
  }
}
