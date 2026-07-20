import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { QUEUES, workerServiceEnvSchema } from '@forge/contracts';
import { PrismaModule } from '@forge/prisma';

import { EmailProcessor } from './email/email.processor';
import { MailService } from './email/mail.service';
import { HealthController } from './health.controller';
import { PdfProcessor } from './pdf/pdf.processor';
import { PdfRendererService } from './pdf/pdf-renderer.service';
import { DeadLetterService } from './queue/dead-letter.service';
import { JobIdempotencyService } from './queue/job-idempotency.service';
import { RpcClientsModule } from './rpc/rpc-clients.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: workerServiceEnvSchema,
      validationOptions: { abortEarly: false },
    }),
    // The worker owns tables as of Sprint 5 — processed_jobs and
    // dead_letter_jobs. This reverses the Sprint 0 note that it never would:
    // queue state that has to survive a Redis flush needs somewhere durable.
    PrismaModule,
    RpcClientsModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),
    BullModule.registerQueue({ name: QUEUES.PDF }, { name: QUEUES.EMAIL }),
  ],
  controllers: [HealthController],
  providers: [
    PdfRendererService,
    MailService,
    DeadLetterService,
    JobIdempotencyService,
    PdfProcessor,
    EmailProcessor,
  ],
})
export class AppModule {}
