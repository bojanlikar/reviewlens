import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/**
 * Shared secret between Open WebUI and this API (Open WebUI sends it as
 * `Authorization: Bearer <key>`). Disabled when LLM_GATEWAY_KEY is empty.
 * This is NOT end-user auth: the portal itself stays login-free.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('LLM_GATEWAY_KEY');
    if (!expected) return true;
    const header: string = context.switchToHttp().getRequest().headers?.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
