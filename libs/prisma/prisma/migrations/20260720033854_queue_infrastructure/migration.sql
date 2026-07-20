-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('CLAIMED', 'COMPLETED');

-- CreateTable
CREATE TABLE "processed_jobs" (
    "id" UUID NOT NULL,
    "job_key" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'CLAIMED',
    "tenant_id" UUID,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "processed_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" UUID NOT NULL,
    "queue_name" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "failed_reason" TEXT NOT NULL,
    "stack_trace" TEXT,
    "attempts" INTEGER NOT NULL,
    "correlation_id" TEXT,
    "tenant_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "processed_jobs_job_key_key" ON "processed_jobs"("job_key");

-- CreateIndex
CREATE INDEX "processed_jobs_state_idx" ON "processed_jobs"("state");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_queue_name_idx" ON "dead_letter_jobs"("queue_name");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_tenant_id_idx" ON "dead_letter_jobs"("tenant_id");


-- ---------------------------------------------------------------------------
-- RLS: one of these tables gets it, the other must not
-- ---------------------------------------------------------------------------

-- processed_jobs: NO RLS, same reasoning as processed_webhooks. The dedupe key
-- has to be globally unique to be a dedupe key; scoping it per tenant would let
-- the same job run once per tenant, which is the duplicate it exists to stop.
-- It holds a job key and a state, nothing worth isolating.

-- dead_letter_jobs: RLS ON. This one is different — `payload` is the full job
-- body, which carries tenant data (invoice IDs, client email addresses). It is
-- operational data *about* tenant data, so it gets the same treatment.
--
-- Operators inspect it as the owner role, which bypasses RLS; the application
-- role sees only its own tenant's failures.
ALTER TABLE "dead_letter_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dead_letter_jobs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dead_letter_jobs"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
