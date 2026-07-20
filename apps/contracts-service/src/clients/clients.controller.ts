import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { CONTRACTS_PATTERNS } from '@forge/contracts';
import type {
  ArchiveClientRpcRequest,
  ClientDto,
  CreateClientRpcRequest,
  GetClientRpcRequest,
  ListClientsRpcRequest,
  PaginatedResult,
  UpdateClientRpcRequest,
} from '@forge/contracts';

import { ClientsService } from './clients.service';

@Controller()
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @MessagePattern(CONTRACTS_PATTERNS.CREATE_CLIENT)
  create(@Payload() payload: CreateClientRpcRequest): Promise<ClientDto> {
    return this.clients.create(payload);
  }

  @MessagePattern(CONTRACTS_PATTERNS.LIST_CLIENTS)
  list(
    @Payload() payload: ListClientsRpcRequest,
  ): Promise<PaginatedResult<ClientDto>> {
    return this.clients.list(payload);
  }

  @MessagePattern(CONTRACTS_PATTERNS.GET_CLIENT)
  get(@Payload() payload: GetClientRpcRequest): Promise<ClientDto> {
    return this.clients.get(payload.tenantId, payload.clientId);
  }

  @MessagePattern(CONTRACTS_PATTERNS.UPDATE_CLIENT)
  update(@Payload() payload: UpdateClientRpcRequest): Promise<ClientDto> {
    return this.clients.update(payload);
  }

  @MessagePattern(CONTRACTS_PATTERNS.ARCHIVE_CLIENT)
  archive(@Payload() payload: ArchiveClientRpcRequest): Promise<ClientDto> {
    return this.clients.archive(payload.tenantId, payload.clientId);
  }
}
