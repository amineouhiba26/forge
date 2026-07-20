import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  AuthResultDto,
  LoginRequestDto,
  LogoutRequestDto,
  RefreshRequestDto,
  SignupRequestDto,
  TENANTS_PATTERNS,
} from '@forge/contracts';

import { TENANTS_CLIENT } from '../rpc/rpc-clients.module';
import { CorrelationId } from '../common/correlation-id.decorator';
import { RpcService } from '../common/rpc.service';
import { Public } from './public.decorator';

/**
 * Every route here is `@Public()`: these are the endpoints used to *obtain* a
 * token, so requiring one would be circular.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(TENANTS_CLIENT) private readonly tenants: ClientProxy,
    private readonly rpc: RpcService,
  ) {}

  @Public()
  @Post('signup')
  signup(
    @Body() body: SignupRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<AuthResultDto> {
    return this.rpc.send(
      'tenants-service',
      this.tenants.send(TENANTS_PATTERNS.SIGNUP, { ...body, correlationId }),
    );
  }

  @Public()
  @Post('login')
  // 200 rather than the POST default of 201: logging in creates no resource.
  @HttpCode(HttpStatus.OK)
  login(
    @Body() body: LoginRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<AuthResultDto> {
    return this.rpc.send(
      'tenants-service',
      this.tenants.send(TENANTS_PATTERNS.LOGIN, { ...body, correlationId }),
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body() body: RefreshRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<AuthResultDto> {
    return this.rpc.send(
      'tenants-service',
      this.tenants.send(TENANTS_PATTERNS.REFRESH, { ...body, correlationId }),
    );
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(
    @Body() body: LogoutRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<{ success: true }> {
    return this.rpc.send(
      'tenants-service',
      this.tenants.send(TENANTS_PATTERNS.LOGOUT, { ...body, correlationId }),
    );
  }
}
