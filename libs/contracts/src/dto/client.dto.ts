import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { Enveloped } from './message-envelope.dto';
import { PaginationQueryDto } from './pagination.dto';

export class CreateClientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;
}

/**
 * Every field optional — this is a PATCH, not a PUT.
 *
 * The distinction matters for a partial update: with a PUT shape, omitting
 * `companyName` would mean "clear it", so a client that only wants to rename
 * a record has to resend every field it does not intend to change.
 */
export class UpdateClientDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;
}

export class ListClientsQueryDto extends PaginationQueryDto {
  /**
   * Archived clients are hidden unless asked for. A list that silently
   * includes them makes "why is this old client still here?" the default
   * experience.
   */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean = false;

  /** Case-insensitive partial match on name, email or company. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export interface ClientDto {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  companyName: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateClientRpcRequest = Enveloped<CreateClientDto> & {
  tenantId: string;
};

export type ListClientsRpcRequest = Enveloped<ListClientsQueryDto> & {
  tenantId: string;
};

export type GetClientRpcRequest = Enveloped<{ clientId: string }> & {
  tenantId: string;
};

export type UpdateClientRpcRequest = Enveloped<UpdateClientDto> & {
  tenantId: string;
  clientId: string;
};

export type ArchiveClientRpcRequest = GetClientRpcRequest;

/** Path/route parameter shared by several client routes. */
export class ClientIdParamDto {
  @IsUUID()
  clientId!: string;
}
