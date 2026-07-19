import { Controller, Get } from '@nestjs/common';

import { PingResponseDto } from '@forge/contracts';

import { PingService } from './ping.service';

@Controller('ping')
export class PingController {
  constructor(private readonly pingService: PingService) {}

  @Get()
  pingAll(): Promise<PingResponseDto[]> {
    return this.pingService.pingAll();
  }
}
