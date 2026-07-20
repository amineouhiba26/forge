import { Test } from '@nestjs/testing';

import { PrismaService } from '@forge/prisma';

import { JobIdempotencyService } from './job-idempotency.service';

const P2002 = { code: 'P2002' };

describe('JobIdempotencyService', () => {
  let service: JobIdempotencyService;
  let processedJob: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    processedJob = {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobIdempotencyService,
        { provide: PrismaService, useValue: { processedJob } },
      ],
    }).compile();

    service = moduleRef.get(JobIdempotencyService);
  });

  afterEach(() => jest.useRealTimers());

  it('claims a key nobody holds', async () => {
    processedJob.create.mockResolvedValue({});

    await expect(service.claim('email:invoice-1', 'tenant-1')).resolves.toEqual(
      {
        proceed: true,
      },
    );
  });

  it('refuses a key whose work already completed', async () => {
    // The whole point: a redelivered job must not send a second email.
    processedJob.create.mockRejectedValue(P2002);
    processedJob.findUnique.mockResolvedValue({
      state: 'COMPLETED',
      claimedAt: new Date(),
    });

    await expect(service.claim('email:invoice-1', 'tenant-1')).resolves.toEqual(
      {
        proceed: false,
        reason: 'already-completed',
      },
    );
  });

  it('backs off while another worker holds a fresh claim', async () => {
    processedJob.create.mockRejectedValue(P2002);
    processedJob.findUnique.mockResolvedValue({
      state: 'CLAIMED',
      claimedAt: new Date(),
    });

    await expect(service.claim('email:invoice-1', 'tenant-1')).resolves.toEqual(
      {
        proceed: false,
        reason: 'in-progress',
      },
    );
  });

  it('reclaims a stale claim left by a crashed worker', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T12:00:00Z'));

    processedJob.create.mockRejectedValue(P2002);
    processedJob.findUnique.mockResolvedValue({
      state: 'CLAIMED',
      // Ten minutes old — past the five-minute staleness threshold.
      claimedAt: new Date('2026-07-20T11:50:00Z'),
    });
    processedJob.update.mockResolvedValue({});

    // Without this the job would be stuck forever behind its own abandoned
    // claim, which is worse than the risk of a duplicate.
    await expect(service.claim('email:invoice-1', 'tenant-1')).resolves.toEqual(
      {
        proceed: true,
      },
    );
    expect(processedJob.update).toHaveBeenCalled();
  });

  it('does not reclaim a claim that is merely a few seconds old', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T12:00:00Z'));

    processedJob.create.mockRejectedValue(P2002);
    processedJob.findUnique.mockResolvedValue({
      state: 'CLAIMED',
      claimedAt: new Date('2026-07-20T11:59:30Z'),
    });

    await expect(service.claim('email:invoice-1', 'tenant-1')).resolves.toEqual(
      {
        proceed: false,
        reason: 'in-progress',
      },
    );
  });

  it('rethrows database errors it does not recognise', async () => {
    // A connection failure must not be mistaken for "already claimed", which
    // would silently skip the work.
    processedJob.create.mockRejectedValue(new Error('connection lost'));

    await expect(service.claim('email:invoice-1', 'tenant-1')).rejects.toThrow(
      'connection lost',
    );
  });

  it('marks completion only when asked', async () => {
    processedJob.update.mockResolvedValue({});

    await service.complete('email:invoice-1');

    const calls = processedJob.update.mock.calls as Array<
      [{ data: { state: string } }]
    >;
    expect(calls[0][0].data.state).toBe('COMPLETED');
  });

  it('releases a claim so the queue retry is not blocked by it', async () => {
    processedJob.delete.mockResolvedValue({});

    await service.release('email:invoice-1');

    expect(processedJob.delete).toHaveBeenCalled();
  });

  it('ignores a release that finds nothing', async () => {
    // Runs on the failure path; throwing here would replace the real error.
    processedJob.delete.mockRejectedValue(new Error('not found'));

    await expect(service.release('email:invoice-1')).resolves.toBeUndefined();
  });
});
