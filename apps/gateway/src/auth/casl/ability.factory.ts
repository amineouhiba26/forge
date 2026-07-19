import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import { Injectable } from '@nestjs/common';

import { AuthenticatedUser, UserRoleDto } from '@forge/contracts';

/**
 * What can be done.
 *
 * `manage` is CASL's wildcard for every action. `issue` is deliberately
 * distinct from `create`: drafting an invoice and actually issuing one to a
 * client are different privileges, and collapsing them would erase the
 * distinction the backlog specifically calls for.
 */
export type Action =
  'manage' | 'create' | 'read' | 'update' | 'delete' | 'issue';

/** What can be acted upon. Subjects for later sprints are declared now so the
 *  rules stay in one place rather than accreting per feature. */
export type Subject =
  'Tenant' | 'User' | 'Client' | 'Contract' | 'Milestone' | 'Invoice' | 'all';

export type AppAbility = MongoAbility<[Action, Subject]>;

/**
 * Builds the permission set for a role.
 *
 * Roles are resolved from verified JWT claims, so this never trusts
 * client-supplied input. Note that abilities say nothing about *tenants* —
 * cross-tenant access is prevented at the database by RLS. Mixing the two
 * concerns here would give two half-enforced mechanisms instead of one
 * complete one each: CASL answers "may this role do this?", RLS answers
 * "whose rows are these?".
 */
@Injectable()
export class AbilityFactory {
  createForUser(user: AuthenticatedUser): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(
      createMongoAbility,
    );

    switch (user.role) {
      case UserRoleDto.OWNER:
        // The owner is the billing and legal responsible party.
        can('manage', 'all');
        break;

      case UserRoleDto.ADMIN:
        can('manage', 'Client');
        can('manage', 'Contract');
        can('manage', 'Milestone');
        can('read', 'Invoice');
        can('create', 'Invoice');
        can('issue', 'Invoice');
        can('read', 'User');

        // Distinction 1: an admin runs the day-to-day business but cannot
        // change who owns the company or delete the tenant itself.
        cannot('manage', 'Tenant');
        // Distinction 2: an admin cannot grant privileges. Otherwise any admin
        // could promote themselves to owner, making the roles equivalent.
        cannot('create', 'User');
        cannot('update', 'User');
        cannot('delete', 'User');
        break;

      case UserRoleDto.MEMBER:
        can('read', 'Client');
        can('read', 'Contract');
        can('read', 'Milestone');
        can('read', 'Invoice');
        // A member does the work, so completing a milestone is theirs to do.
        can('update', 'Milestone');

        // Distinction 3: the backlog's example — a member sees contracts but
        // cannot turn one into money.
        cannot('create', 'Invoice');
        cannot('issue', 'Invoice');
        cannot('manage', 'User');
        cannot('manage', 'Tenant');
        break;
    }

    return build({
      // Subjects are plain strings here rather than classes, because the
      // gateway proxies DTOs and never holds domain entities.
      detectSubjectType: (subject) => subject,
    });
  }
}
