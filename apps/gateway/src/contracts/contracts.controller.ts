import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  CONTRACTS_PATTERNS,
  ContractDto,
  CreateContractDto,
  ListContractsQueryDto,
  UpdateContractDto,
} from '@forge/contracts';
import type {
  AuthenticatedUser,
  MilestoneDto,
  PaginatedResult,
} from '@forge/contracts';

import { RequirePermission } from '../auth/casl/require-permission.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../common/correlation-id.decorator';
import { rpc } from '../common/rpc';
import { CONTRACTS_CLIENT } from '../rpc/rpc-clients.module';

@Controller('contracts')
export class ContractsController {
  constructor(
    @Inject(CONTRACTS_CLIENT) private readonly contracts: ClientProxy,
  ) {}

  @Post()
  @RequirePermission('create', 'Contract')
  create(
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ContractDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.CREATE_CONTRACT, {
        ...body,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get()
  @RequirePermission('read', 'Contract')
  list(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<PaginatedResult<ContractDto>> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.LIST_CONTRACTS, {
        ...query,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get(':id')
  @RequirePermission('read', 'Contract')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ContractDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.GET_CONTRACT, {
        contractId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('update', 'Contract')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateContractDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ContractDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.UPDATE_CONTRACT, {
        ...body,
        contractId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get(':id/milestones')
  @RequirePermission('read', 'Milestone')
  listMilestones(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<MilestoneDto[]> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.LIST_MILESTONES, {
        contractId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  /**
   * Completing a milestone is `update Milestone`, which a MEMBER may do —
   * doing the work is their job. Creating and editing the contract itself is
   * not. This is the permission split the backlog asks for, and the reason
   * `Milestone` is a separate CASL subject from `Contract`.
   */
  @Patch(':id/milestones/:milestoneId/complete')
  @RequirePermission('update', 'Milestone')
  completeMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<MilestoneDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.COMPLETE_MILESTONE, {
        contractId: id,
        milestoneId,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }
}
