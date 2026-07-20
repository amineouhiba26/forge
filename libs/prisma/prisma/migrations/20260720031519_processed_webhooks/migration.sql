-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "last_payment_error" TEXT,
ADD COLUMN     "stripe_payment_intent_id" TEXT;

-- CreateTable
CREATE TABLE "processed_webhooks" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "tenant_id" UUID,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhooks_event_id_key" ON "processed_webhooks"("event_id");

-- CreateIndex
CREATE INDEX "processed_webhooks_event_type_idx" ON "processed_webhooks"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_payment_intent_id_key" ON "invoices"("stripe_payment_intent_id");


-- ---------------------------------------------------------------------------
-- processed_webhooks is deliberately NOT tenant-scoped and has NO RLS policy
-- ---------------------------------------------------------------------------
-- Every other tenant-owned table in this schema enables and forces RLS. This
-- one must not, and the reason is the whole point of the table:
--
-- Stripe event IDs are unique per *account*, not per tenant. Tenant-scoping the
-- uniqueness would let the same event be processed once under each tenant —
-- precisely the double application this table exists to prevent. The dedupe
-- key has to be global to be a dedupe key at all.
--
-- The row holds no tenant data: an event ID, an event type, and a nullable
-- tenant_id kept only so a replay can be traced back. Nothing here is worth
-- isolating, and isolating it would break the guarantee.
--
-- The grant still applies (ALTER DEFAULT PRIVILEGES from the RLS migration),
-- so forge_app can read and write it without being able to alter it.
