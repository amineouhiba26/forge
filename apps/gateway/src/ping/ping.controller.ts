import { Controller, Get } from '@nestjs/common';

import { PingResponseDto } from '@forge/contracts';

import { Public } from '../auth/public.decorator';
import { PingService } from './ping.service';

@Controller('ping')
export class PingController {
  constructor(private readonly pingService: PingService) {}

  // Public: this is the Sprint 0 transport smoke test, not a data endpoint.
  @Public()
  @Get()
  pingAll(): Promise<PingResponseDto[]> {
    return this.pingService.pingAll();
  }
}
