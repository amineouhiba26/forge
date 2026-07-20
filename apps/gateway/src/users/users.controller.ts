import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import { AuthUserDto, TENANTS_PATTERNS } from '@forge/contracts';
// `import type` is required: `AuthenticatedUser` is an interface, so it has no
// runtime value, and `emitDecoratorMetadata` would otherwise emit a reference
// to something that does not exist once the types are erased.
import type { AuthenticatedUser } from '@forge/contracts';

import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/casl/require-permission.decorator';
import { TENANTS_CLIENT } from '../rpc/rpc-clients.module';
import { CorrelationId } from '../common/correlation-id.decorator';
import { RpcService } from '../common/rpc.service';

@Controller('users')
export class UsersController {
  constructor(
    @Inject(TENANTS_CLIENT) private readonly tenants: ClientProxy,
    private readonly rpc: RpcService,
  ) {}

  @Get()
  @RequirePermission('read', 'User')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<AuthUserDto[]> {
    return this.rpc.send(
      'tenants-service',
      this.tenants.send(TENANTS_PATTERNS.LIST_USERS, {
        // Taken from verified JWT claims, never from the request. A client
        // cannot ask for another tenant's users by editing a payload — and
        // even if this were wrong, RLS would still refuse the rows.
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get(':id')
  @RequirePermission('read', 'User')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<AuthUserDto> {
    return this.rpc.send(
      'tenants-service',
      this.tenants.send(TENANTS_PATTERNS.GET_USER, {
        tenantId: user.tenantId,
        userId: id,
        correlationId,
      }),
    );
  }
}
