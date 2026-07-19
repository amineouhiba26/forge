import { AuthenticatedUser, UserRoleDto } from '@forge/contracts';

import { AbilityFactory } from './ability.factory';

describe('AbilityFactory', () => {
  const factory = new AbilityFactory();

  const userWithRole = (role: UserRoleDto): AuthenticatedUser => ({
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    email: 'user@example.test',
    role,
  });

  describe('OWNER', () => {
    const ability = factory.createForUser(userWithRole(UserRoleDto.OWNER));

    it('can manage everything', () => {
      expect(ability.can('manage', 'all')).toBe(true);
      expect(ability.can('issue', 'Invoice')).toBe(true);
      expect(ability.can('delete', 'Tenant')).toBe(true);
      expect(ability.can('create', 'User')).toBe(true);
    });
  });

  describe('ADMIN', () => {
    const ability = factory.createForUser(userWithRole(UserRoleDto.ADMIN));

    it('runs the day-to-day business', () => {
      expect(ability.can('create', 'Contract')).toBe(true);
      expect(ability.can('update', 'Client')).toBe(true);
      expect(ability.can('issue', 'Invoice')).toBe(true);
    });

    // Distinction 1 from the ability factory.
    it('cannot modify the tenant itself', () => {
      expect(ability.can('update', 'Tenant')).toBe(false);
      expect(ability.can('delete', 'Tenant')).toBe(false);
    });

    // Distinction 2. Without this an admin could promote itself to owner,
    // which would make the two roles the same thing with different names.
    it('cannot grant privileges by creating or editing users', () => {
      expect(ability.can('create', 'User')).toBe(false);
      expect(ability.can('update', 'User')).toBe(false);
      expect(ability.can('delete', 'User')).toBe(false);
      expect(ability.can('read', 'User')).toBe(true);
    });
  });

  describe('MEMBER', () => {
    const ability = factory.createForUser(userWithRole(UserRoleDto.MEMBER));

    // Distinction 3 — the backlog's own example.
    it('can view contracts but cannot turn them into money', () => {
      expect(ability.can('read', 'Contract')).toBe(true);
      expect(ability.can('read', 'Invoice')).toBe(true);
      expect(ability.can('create', 'Invoice')).toBe(false);
      expect(ability.can('issue', 'Invoice')).toBe(false);
    });

    it('can complete a milestone, since that is the work itself', () => {
      expect(ability.can('update', 'Milestone')).toBe(true);
    });

    it('cannot create or modify contracts and clients', () => {
      expect(ability.can('create', 'Contract')).toBe(false);
      expect(ability.can('update', 'Contract')).toBe(false);
      expect(ability.can('create', 'Client')).toBe(false);
    });

    it('cannot touch users or the tenant', () => {
      expect(ability.can('read', 'User')).toBe(false);
      expect(ability.can('update', 'Tenant')).toBe(false);
    });
  });

  it('grants nothing for an unrecognised role', () => {
    // Fails closed. If a role is ever added to the enum without a matching
    // branch here, the safe outcome is no permissions rather than inherited
    // ones from whichever case happened to fall through.
    const ability = factory.createForUser(
      userWithRole('SUPERUSER' as UserRoleDto),
    );

    expect(ability.can('read', 'Contract')).toBe(false);
    expect(ability.can('manage', 'all')).toBe(false);
  });
});
