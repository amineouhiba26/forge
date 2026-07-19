import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  AuthUserDto,
  MessageEnvelopeDto,
  TENANTS_PATTERNS,
} from '@forge/contracts';

import { UsersService } from './users.service';

/**
 * `tenantId` arrives from the gateway, which reads it from verified JWT
 * claims. A client cannot set it: the gateway overwrites whatever the body
 * contained before forwarding.
 */
interface ScopedRequest extends MessageEnvelopeDto {
  tenantId: string;
}

interface GetUserRequest extends ScopedRequest {
  userId: string;
}

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @MessagePattern(TENANTS_PATTERNS.LIST_USERS)
  list(@Payload() payload: ScopedRequest): Promise<AuthUserDto[]> {
    return this.users.list(payload.tenantId);
  }

  @MessagePattern(TENANTS_PATTERNS.GET_USER)
  get(@Payload() payload: GetUserRequest): Promise<AuthUserDto> {
    return this.users.get(payload.tenantId, payload.userId);
  }
}
