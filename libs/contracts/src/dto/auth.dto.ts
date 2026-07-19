import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { Enveloped } from './message-envelope.dto';

/** Mirrors the `UserRole` enum in the Prisma schema. */
export enum UserRoleDto {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

export class SignupTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  /** ISO 3166-1 alpha-2. Drives tax calculation in Sprint 3. */
  @IsISO31661Alpha2()
  country!: string;
}

export class SignupOwnerDto {
  @IsEmail()
  email!: string;

  // A maximum matters as much as a minimum: bcrypt silently truncates input
  // beyond 72 bytes, and an unbounded password is a cheap way to burn CPU.
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;
}

export class SignupRequestDto {
  @ValidateNested()
  @Type(() => SignupTenantDto)
  tenant!: SignupTenantDto;

  @ValidateNested()
  @Type(() => SignupOwnerDto)
  owner!: SignupOwnerDto;
}

export class LoginRequestDto {
  /**
   * Required because email is unique *per tenant*, not globally — the same
   * address may hold accounts in several tenants, so it cannot identify one on
   * its own. A production system would resolve this from a subdomain or a
   * tenant slug rather than making the client supply a UUID.
   */
  @IsUUID()
  tenantId!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshRequestDto {
  /**
   * Required, and narrower than the optional `tenantId` on the envelope.
   *
   * Refresh is reached precisely when the access token has expired, so the
   * gateway cannot derive the tenant from JWT claims — there is no usable
   * token left to read. The client has to say which tenant it is refreshing
   * against. Naming the wrong one simply finds no token: the lookup runs
   * inside that tenant's RLS scope, so it cannot reach anyone else's rows.
   */
  @IsUUID()
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class LogoutRequestDto {
  /** Required for the same reason as on refresh — see above. */
  @IsUUID()
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class AuthUserDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  tenantId!: string;

  @IsEmail()
  email!: string;

  @IsEnum(UserRoleDto)
  role!: UserRoleDto;
}

export class TokenPairDto {
  @IsString()
  accessToken!: string;

  @IsString()
  refreshToken!: string;
}

export class AuthResultDto {
  user!: AuthUserDto;
  tokens!: TokenPairDto;
}

/**
 * The decoded access-token payload.
 *
 * `sub`, `iat` and `exp` are registered JWT claims; the rest are ours. Role
 * travels in the token so the gateway can authorise without a round-trip to
 * tenants-service on every request — the trade-off is that a role change only
 * takes effect when the access token expires, which is why the access TTL is
 * short.
 */
export interface AccessTokenClaims {
  /** User ID. `sub` is the registered claim for the token's subject. */
  sub: string;
  tenantId: string;
  email: string;
  role: UserRoleDto;
  iat?: number;
  exp?: number;
}

/** The authenticated principal attached to a request by the JWT strategy. */
export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  role: UserRoleDto;
}

/**
 * What tenants-service actually receives: the validated client DTO plus the
 * gateway-added envelope.
 */
export type SignupRpcRequest = Enveloped<SignupRequestDto>;
export type LoginRpcRequest = Enveloped<LoginRequestDto>;
export type RefreshRpcRequest = Enveloped<RefreshRequestDto>;
export type LogoutRpcRequest = Enveloped<LogoutRequestDto>;
