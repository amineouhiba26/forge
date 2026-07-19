import { SetMetadata } from '@nestjs/common';

import { Action, Subject } from './ability.factory';

export const PERMISSION_KEY = 'required_permission';

export interface RequiredPermission {
  action: Action;
  subject: Subject;
}

/**
 * Declares what a route requires, e.g. `@RequirePermission('issue', 'Invoice')`.
 *
 * The check itself lives in `JwtCaslGuard`. Keeping the requirement next to the
 * handler means the rule is visible where the route is read, rather than in a
 * permissions table nobody opens.
 */
export const RequirePermission = (action: Action, subject: Subject) =>
  SetMetadata<string, RequiredPermission>(PERMISSION_KEY, { action, subject });
