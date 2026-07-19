import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { AuthenticatedUser } from '@forge/contracts';

import { AbilityFactory } from './casl/ability.factory';
import {
  PERMISSION_KEY,
  RequiredPermission,
} from './casl/require-permission.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * One guard doing authentication then authorisation, in that order.
 *
 * They are combined rather than chained as two guards because the second
 * depends entirely on the first: CASL rules are derived from the role claim,
 * which is only trustworthy once the signature has been verified. Two separate
 * guards would make it possible to apply the permission check without the auth
 * check and get a confident-looking decision built on unverified input.
 */
@Injectable()
export class JwtCaslGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: AbilityFactory,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Step 1 — authenticate. Delegates to Passport, which verifies the
    // signature and expiry and populates `request.user`.
    await super.canActivate(context);

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException();
    }

    // Step 2 — authorise. A route with no declared permission needs a valid
    // token and nothing more.
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const ability = this.abilityFactory.createForUser(user);

    if (!ability.can(required.action, required.subject)) {
      throw new ForbiddenException(
        `Your role (${user.role}) cannot ${required.action} ${required.subject}`,
      );
    }

    return true;
  }
}
