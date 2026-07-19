import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Prisma 7 connects through a driver adapter rather than a URL baked into
    // the schema. DATABASE_URL is already Joi-validated by the owning app's
    // ConfigModule, so a bad value fails the boot before reaching here.
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly so an unreachable database fails the boot rather than
    // the first request that happens to touch it.
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
