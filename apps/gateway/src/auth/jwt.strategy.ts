import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AccessTokenClaims, AuthenticatedUser } from '@forge/contracts';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Never true. An expired token is not a valid one, and this flag is the
      // single most common way JWT auth is accidentally disabled.
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // Refusing `none` is the defence against the classic algorithm-confusion
      // attack, where a forged token declares itself unsigned.
      algorithms: ['HS256'],
    });
  }

  /**
   * Runs only after the signature and expiry have been verified, so these
   * claims are trustworthy — they came from a token this service signed.
   *
   * The return value becomes `request.user`.
   */
  validate(claims: AccessTokenClaims): AuthenticatedUser {
    return {
      userId: claims.sub,
      tenantId: claims.tenantId,
      email: claims.email,
      role: claims.role,
    };
  }
}
