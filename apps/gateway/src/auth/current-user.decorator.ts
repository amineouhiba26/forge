import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedUser } from '@forge/contracts';

/**
 * Injects the verified principal into a handler.
 *
 * Handlers read the tenant from here and never from the request body, so a
 * client cannot choose the tenant it operates on by editing a payload.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();

    return request.user;
  },
);
