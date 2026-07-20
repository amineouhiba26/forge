import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { CONTRACTS_PATTERNS } from '@forge/contracts';
import type {
  CompleteMilestoneRpcRequest,
  ContractDto,
  CreateContractRpcRequest,
  GetContractRpcRequest,
  ListContractsRpcRequest,
  ListMilestonesRpcRequest,
  MilestoneDto,
  PaginatedResult,
  UpdateContractRpcRequest,
} from '@forge/contracts';

import { ContractsService } from './contracts.service';

@Controller()
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @MessagePattern(CONTRACTS_PATTERNS.CREATE_CONTRACT)
  create(@Payload() payload: CreateContractRpcRequest): Promise<ContractDto> {
    return this.contracts.create(payload);
  }

  @MessagePattern(CONTRACTS_PATTERNS.LIST_CONTRACTS)
  list(
    @Payload() payload: ListContractsRpcRequest,
  ): Promise<PaginatedResult<ContractDto>> {
    return this.contracts.list(payload);
  }

  @MessagePattern(CONTRACTS_PATTERNS.GET_CONTRACT)
  get(@Payload() payload: GetContractRpcRequest): Promise<ContractDto> {
    return this.contracts.get(payload.tenantId, payload.contractId);
  }

  @MessagePattern(CONTRACTS_PATTERNS.UPDATE_CONTRACT)
  update(@Payload() payload: UpdateContractRpcRequest): Promise<ContractDto> {
    return this.contracts.update(payload);
  }

  @MessagePattern(CONTRACTS_PATTERNS.LIST_MILESTONES)
  listMilestones(
    @Payload() payload: ListMilestonesRpcRequest,
  ): Promise<MilestoneDto[]> {
    return this.contracts.listMilestones(payload.tenantId, payload.contractId);
  }

  @MessagePattern(CONTRACTS_PATTERNS.COMPLETE_MILESTONE)
  completeMilestone(
    @Payload() payload: CompleteMilestoneRpcRequest,
  ): Promise<MilestoneDto> {
    return this.contracts.completeMilestone(
      payload.tenantId,
      payload.contractId,
      payload.milestoneId,
    );
  }
}
