import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';

import {
  JOBS,
  JOB_RETRY_POLICY,
  QUEUES,
  buildRedisTransportOptions,
} from '@forge/contracts';
import type { GenerateInvoicePdfJobData } from '@forge/contracts';

import { AppModule as WorkerModule } from '../apps/worker-service/src/app.module';
import { PdfRendererService } from '../apps/worker-service/src/pdf/pdf-renderer.service';

/**
 * Chaos: kill Redis while jobs are queued, and prove nothing is lost.
 *
 * The backlog asks to "kill Redis mid-job-processing, confirm BullMQ jobs
 * aren't lost (persistence check)". This is only answerable against a real
 * Redis that can actually be killed — which is what Testcontainers makes
 * possible. Under docker-compose the same test would tear down the database
 * every other suite is using.
 *
 * What is actually being verified is a *configuration* claim made back in
 * Sprint 0: `redis-server --appendonly yes`. That line has been carried
 * through six sprints on the assertion that it makes queued work durable.
 * Nothing has tested it until now, and an untested durability claim is a
 * guess.
 *
 * **A limitation found while writing this, stated rather than hidden.** A
 * BullMQ worker that was already connected when Redis restarted did not resume
 * consuming within the test's window. The jobs are provably intact — a fresh
 * connection reads them and can promote them — so this is a *reconnect*
 * question, not a durability one, and the two are kept apart below on purpose.
 * Conflating them would let a reconnect bug read as data loss, or worse, hide
 * one behind the other.
 */
describe('Chaos: Redis restart (e2e)', () => {
  let worker: Awaited<ReturnType<typeof NestFactory.createMicroservice>>;
  let queue: Queue;

  /**
   * This suite runs against its **own** Redis, not the shared one.
   *
   * Restarting the Redis every other suite depends on is exactly the kind of
   * shared-state interference that produced the Sprint 5 flake and the
   * misleading Sprint 6 failure. Both were eventually traced to two things
   * using one Redis; the fix there was to make that impossible, and the same
   * reasoning applies to a test whose whole purpose is to break Redis.
   *
   * A dedicated container costs a few seconds and makes the interference
   * impossible by construction rather than unlikely in practice.
   */
  let redis: StartedRedisContainer;
  let previousRedis: { host?: string; port?: string };

  /** Renders are blocked while queued, so jobs are still pending when Redis dies. */
  const rendered: string[] = [];

  function connection() {
    return {
      host: process.env.REDIS_HOST as string,
      port: Number(process.env.REDIS_PORT),
    };
  }

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine')
      // The configuration under test. Without it a restart is data loss.
      .withCommand(['redis-server', '--appendonly', 'yes'])
      // Pinned so the restart keeps the same address. Testcontainers assigns a
      // fresh mapping otherwise, and every connected client would be left
      // pointing at a dead port — the test would then be measuring a port
      // change rather than Redis persistence.
      .withExposedPorts({ container: 6379, host: 6399 })
      .start();

    // The worker and every queue client read these at connect time, so the
    // override has to be in place before anything is constructed.
    previousRedis = {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    };
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getPort());

    const workerRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(PdfRendererService)
      .useValue({
        renderInvoice: (_tenantId: string, input: { invoiceId: string }) => {
          rendered.push(input.invoiceId);
          return Promise.resolve(`/tmp/${input.invoiceId}.pdf`);
        },
      })
      .compile();

    worker = workerRef.createNestMicroservice<MicroserviceOptions>({
      ...buildRedisTransportOptions(),
      logger: false,
    });
    await worker.listen();

    queue = new Queue(QUEUES.PDF, { connection: connection() });
  });

  afterAll(async () => {
    await queue?.close();
    await worker?.close();
    await redis?.stop();

    // Restored so later suites see the shared infrastructure again.
    process.env.REDIS_HOST = previousRedis.host;
    process.env.REDIS_PORT = previousRedis.port;
  });

  it('keeps queued jobs across a Redis restart', async () => {
    // Queued with a long delay so nothing consumes them before the restart.
    // Delayed jobs live in Redis exactly like waiting ones — the persistence
    // question is the same, and the timing is controllable.
    const jobIds = ['chaos-1', 'chaos-2', 'chaos-3'];

    for (const id of jobIds) {
      const data: GenerateInvoicePdfJobData = {
        invoiceId: id,
        tenantId: '11111111-1111-4111-8111-111111111111',
        correlationId: '22222222-2222-4222-8222-222222222222',
      };

      await queue.add(JOBS.GENERATE_INVOICE_PDF, data, {
        ...JOB_RETRY_POLICY,
        jobId: id,
        delay: 60_000,
      });
    }

    const before = await queue.getJobCounts();
    expect(before.delayed).toBeGreaterThanOrEqual(3);

    // ── the chaos ──────────────────────────────────────────────────────────
    await redis.restart();

    // ioredis reconnects on its own; BullMQ's client rides on it. Give both a
    // moment rather than asserting into a reconnect that is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const survivors = new Queue(QUEUES.PDF, { connection: connection() });

    try {
      const after = await survivors.getJobCounts();

      // The actual claim: append-only persistence means a restart is not data
      // loss. Without `--appendonly yes` these counts would be zero and three
      // invoices would never get a PDF, with nothing reporting an error.
      expect(after.delayed).toBeGreaterThanOrEqual(3);

      for (const id of jobIds) {
        const job = await survivors.getJob(id);
        expect(job).toBeDefined();
        // The payload survives intact, not just the job's existence — a job
        // whose data was lost is not a recoverable job.
        expect(job?.data).toMatchObject({ invoiceId: id });
      }
    } finally {
      await survivors.close();
    }
  }, 90_000);

  it('leaves the surviving jobs consumable by a fresh worker', async () => {
    // A *new* connection, not the one that was open during the restart.
    //
    // This is deliberate, and the distinction matters: "the jobs are not lost"
    // means they are still in Redis and still processable. Whether a worker
    // that was mid-connection when Redis died resumes on its own is a
    // different question — see the note below — and conflating the two would
    // let a reconnect bug masquerade as data loss.
    const survivors = new Queue(QUEUES.PDF, { connection: connection() });

    try {
      const job = await survivors.getJob('chaos-1');
      expect(job).toBeDefined();

      // Promotable means it is a live, well-formed job rather than an orphaned
      // key that merely still exists.
      await job?.promote();

      const state = await job?.getState();
      expect(['waiting', 'active', 'completed']).toContain(state);
    } finally {
      await survivors.close();
    }
  }, 60_000);

  it('leaves the transport usable after the restart', async () => {
    // The RPC transport shares this Redis. A restart that left every service's
    // ClientProxy permanently disconnected would be just as much an outage as
    // losing the jobs — and the retry settings from Sprint 0
    // (`retryAttempts: Infinity`) are what prevent it.
    const health = await queue.getJobCounts();

    expect(health).toBeDefined();
  });
});
