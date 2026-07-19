import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsISO4217CurrencyCode,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { Enveloped } from './message-envelope.dto';
import { PaginationQueryDto } from './pagination.dto';

/** Mirrors `ContractStatus` in the Prisma schema. */
export enum ContractStatusDto {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** Mirrors `MilestoneStatus` in the Prisma schema. */
export enum MilestoneStatusDto {
  PENDING = 'PENDING',
  COMPLETE = 'COMPLETE',
}

export class CreateMilestoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  /**
   * Sent as a number and stored as `Decimal(12,2)`.
   *
   * `@IsPositive` rules out zero and negative amounts: a milestone worth
   * nothing is a data-entry error, and a negative one is a credit note — a
   * different concept that does not belong in this shape.
   */
  @Type(() => Number)
  @IsPositive()
  amount!: number;

  @IsDateString()
  dueDate!: string;
}

export class CreateContractDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  /**
   * Nested validation, the backlog's explicit requirement.
   *
   * `@ValidateNested({ each: true })` plus `@Type` is what makes class-validator
   * descend into the array. Without `@Type`, the incoming objects stay plain
   * and the nested rules never run — the array passes validation while
   * containing arbitrary junk. It fails silently, which is why it is worth
   * knowing rather than copying.
   */
  @IsArray()
  @ArrayMinSize(1, {
    message:
      'A contract needs at least one milestone — it is what makes it billable.',
  })
  // A bound on the array is a bound on the work one request can create.
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateMilestoneDto)
  milestones!: CreateMilestoneDto[];
}

export class UpdateContractDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsEnum(ContractStatusDto)
  status?: ContractStatusDto;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class ListContractsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ContractStatusDto)
  status?: ContractStatusDto;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export interface MilestoneDto {
  id: string;
  contractId: string;
  title: string;
  /** Serialised as a string: see the Decimal note in the schema. */
  amount: string;
  dueDate: string;
  status: MilestoneStatusDto;
  completedAt: string | null;
}

export interface ContractDto {
  id: string;
  tenantId: string;
  clientId: string;
  title: string;
  description: string | null;
  status: ContractStatusDto;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  milestones: MilestoneDto[];
  createdAt: string;
  updatedAt: string;
}

export type CreateContractRpcRequest = Enveloped<CreateContractDto> & {
  tenantId: string;
};

export type ListContractsRpcRequest = Enveloped<ListContractsQueryDto> & {
  tenantId: string;
};

export type GetContractRpcRequest = Enveloped<{ contractId: string }> & {
  tenantId: string;
};

export type UpdateContractRpcRequest = Enveloped<UpdateContractDto> & {
  tenantId: string;
  contractId: string;
};

export type ListMilestonesRpcRequest = GetContractRpcRequest;

export type CompleteMilestoneRpcRequest = Enveloped<{
  contractId: string;
  milestoneId: string;
}> & { tenantId: string };
