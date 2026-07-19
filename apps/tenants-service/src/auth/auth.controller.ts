import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { AuthResultDto, TENANTS_PATTERNS } from '@forge/contracts';
// Type-only: these are aliases with no runtime value, and they appear in
// decorated signatures where `emitDecoratorMetadata` would try to reference them.
import type {
  LoginRpcRequest,
  LogoutRpcRequest,
  RefreshRpcRequest,
  SignupRpcRequest,
} from '@forge/contracts';

import { AuthService } from './auth.service';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @MessagePattern(TENANTS_PATTERNS.SIGNUP)
  signup(@Payload() payload: SignupRpcRequest): Promise<AuthResultDto> {
    return this.auth.signup(payload);
  }

  @MessagePattern(TENANTS_PATTERNS.LOGIN)
  login(@Payload() payload: LoginRpcRequest): Promise<AuthResultDto> {
    return this.auth.login(payload);
  }

  @MessagePattern(TENANTS_PATTERNS.REFRESH)
  refresh(@Payload() payload: RefreshRpcRequest): Promise<AuthResultDto> {
    return this.auth.refresh(payload);
  }

  @MessagePattern(TENANTS_PATTERNS.LOGOUT)
  logout(@Payload() payload: LogoutRpcRequest): Promise<{ success: true }> {
    return this.auth.logout(payload);
  }
}
