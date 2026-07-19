import {
  Body,
  Controller,
  Delete,
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
  ClientDto,
  CONTRACTS_PATTERNS,
  CreateClientDto,
  ListClientsQueryDto,
  UpdateClientDto,
} from '@forge/contracts';
import type { AuthenticatedUser, PaginatedResult } from '@forge/contracts';

import { RequirePermission } from '../auth/casl/require-permission.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CONTRACTS_CLIENT } from '../rpc/rpc-clients.module';
import { CorrelationId } from '../common/correlation-id.decorator';
import { rpc } from '../common/rpc';

@Controller('clients')
export class ClientsController {
  constructor(
    @Inject(CONTRACTS_CLIENT) private readonly contracts: ClientProxy,
  ) {}

  @Post()
  @RequirePermission('create', 'Client')
  create(
    @Body() body: CreateClientDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ClientDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.CREATE_CLIENT, {
        ...body,
        // From verified JWT claims, never the request body.
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get()
  @RequirePermission('read', 'Client')
  list(
    @Query() query: ListClientsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<PaginatedResult<ClientDto>> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.LIST_CLIENTS, {
        ...query,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get(':id')
  @RequirePermission('read', 'Client')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ClientDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.GET_CLIENT, {
        clientId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('update', 'Client')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateClientDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ClientDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.UPDATE_CLIENT, {
        ...body,
        clientId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  /**
   * DELETE archives rather than destroying — see `ClientsService.archive`.
   * The verb is kept because that is what a caller reaches for; the response
   * returns the archived record so the soft-delete is visible, not implied.
   */
  @Delete(':id')
  @RequirePermission('delete', 'Client')
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<ClientDto> {
    return rpc(
      this.contracts.send(CONTRACTS_PATTERNS.ARCHIVE_CLIENT, {
        clientId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }
}
