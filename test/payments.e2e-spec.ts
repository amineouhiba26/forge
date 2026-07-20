import 'dotenv/config';

import { createHmac, randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { InvoiceStatusDto, buildRedisTransportOptions } from '@forge/contracts';
import type {
  AuthResultDto,
  ClientDto,
  ContractDto,
  InvoiceDto,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { AppModule as BillingModule } from '../apps/billing-service/src/app.module';
import { StripeService } from '../apps/billing-service/src/stripe/stripe.service';
import { AppModule as ContractsModule } from '../apps/contracts-service/src/app.module';
import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';
import { assertNoCompetingServices } from './support/no-competing-services';
import { AppModule as WorkerModule } from '../apps/worker-service/src/app.module';

function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

let app: INestApplication;

function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string;

/**
 * Builds the `stripe-signature` header exactly as Stripe does.
 *
 * `t=<unix>,v1=<HMAC-SHA256(`${t}.${payload}`, secret)>`
 *
 * Reimplemented here rather than mocked so verification is genuinely
 * exercised: the code under test uses the real `stripe.webhooks.constructEvent`
 * with real HMAC. A mocked verifier would prove nothing about the one control
 * standing between the open internet and payment state.
 */
function stripeSignature(
  payload: string,
  secret: string = WEBHOOK_SECRET,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

interface WebhookOptions {
  eventId?: string;
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed';
  paymentIntentId?: string;
  amountInCents: number;
  tenantId: string;
  invoiceId: string;
  failureMessage?: string;
}

/** A Stripe event payload, shaped as Stripe actually delivers it. */
function webhookPayload(options: WebhookOptions): string {
  return JSON.stringify({
    id: options.eventId ?? `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    api_version: '2026-06-24.dahlia',
    created: Math.floor(Date.now() / 1000),
    type: options.type,
    data: {
      object: {
        id: options.paymentIntentId ?? `pi_${randomUUID().replace(/-/g, '')}`,
        object: 'payment_intent',
        amount: options.amountInCents,
        currency: 'eur',
        status:
          options.type === 'payment_intent.succeeded'
            ? 'succeeded'
            : 'requires_payment_method',
        last_payment_error: options.failureMessage
          ? { message: options.failureMessage }
          : null,
        metadata: {
          tenantId: options.tenantId,
          invoiceId: options.invoiceId,
          correlationId: randomUUID(),
        },
      },
    },
  });
}

/**
 * Sprint 4: Stripe webhooks that survive real-world delivery — duplicates,
 * replays and out-of-order arrival.
 *
 * No Stripe account is contacted. `createPaymentIntent` is stubbed because it
 * is the only method that makes a network call; signature verification is left
 * real, since that is the security control under test.
 */
describe('Payments & webhook idempotency (e2e)', () => {
  const services: Awaited<ReturnType<typeof NestFactory.createMicroservice>>[] =
    [];
  let prisma: PrismaService;

  const run = Date.now();
  let tenant: { tenantId: string; token: string };
  let otherTenant: { tenantId: string; token: string };
  let clientId: string;

  /** Records what the stub was asked to create, so tests can assert on it. */
  const createdIntents: { invoiceId: string; amountInCents: number }[] = [];

  beforeAll(async () => {
    // Fails fast and explains itself if another stack is on this Redis.
    await assertNoCompetingServices();

    for (const module of [TenantsModule, ContractsModule, WorkerModule]) {
      const service = await NestFactory.createMicroservice<MicroserviceOptions>(
        module,
        { ...buildRedisTransportOptions(), logger: false },
      );
      await service.listen();
      services.push(service);
    }

    // Billing is built through the testing module so Stripe's *network* call
    // can be replaced while its *crypto* is left alone.
    const realStripe = new StripeService({
      getOrThrow: (key: string) => process.env[key],
    } as never);

    const billingRef = await Test.createTestingModule({
      imports: [BillingModule],
    })
      .overrideProvider(StripeService)
      .useValue({
        createPaymentIntent: (input: {
          invoiceId: string;
          amountInCents: number;
        }) => {
          createdIntents.push(input);
          return Promise.resolve({
            id: `pi_stub_${randomUUID().replace(/-/g, '')}`,
            client_secret: 'pi_stub_secret',
          });
        },
        // Delegated to the real implementation — real HMAC, real tolerance
        // window, real failure modes.
        constructEvent: (raw: string, signature: string) =>
          realStripe.constructEvent(raw, signature),
      })
      .compile();

    const billing = billingRef.createNestMicroservice<MicroserviceOptions>({
      ...buildRedisTransportOptions(),
      logger: false,
    });
    await billing.listen();
    services.push(billing);

    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = services[0].get(PrismaService, { strict: false });

    tenant = await signup(`pay-${run}@acme.test`, `Payments ${run}`);
    otherTenant = await signup(`pay-other-${run}@globex.test`, `Other ${run}`);
    clientId = await createClient(tenant.token, `client-${run}@wayne.test`);
  });

  afterAll(async () => {
    await app?.close();
    for (const service of services) await service.close();
  });

  async function signup(email: string, name: string) {
    const response = await request(server())
      .post('/auth/signup')
      .send({
        tenant: { name, country: 'FR' },
        owner: { email, password: 'a-long-enough-password' },
      })
      .expect(201);

    const result = body<AuthResultDto>(response);
    return {
      tenantId: result.user.tenantId,
      token: result.tokens.accessToken,
    };
  }

  async function createClient(token: string, email: string) {
    const response = await request(server())
      .post('/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Wayne Enterprises', email })
      .expect(201);

    return body<ClientDto>(response).id;
  }

  /** Drives contract → milestone complete → invoice → ISSUED. */
  async function issuedInvoice(amount: number): Promise<InvoiceDto> {
    const created = await request(server())
      .post('/contracts')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({
        clientId,
        title: `Contract ${Math.random()}`,
        milestones: [{ title: 'Work', amount, dueDate: '2026-09-01' }],
      })
      .expect(201);

    const contract = body<ContractDto>(created);

    await request(server())
      .patch(`/contracts/${contract.id}`)
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ status: 'ACTIVE' })
      .expect(200);

    await request(server())
      .patch(
        `/contracts/${contract.id}/milestones/${contract.milestones[0].id}/complete`,
      )
      .set('Authorization', `Bearer ${tenant.token}`)
      .expect(200);

    const invoiceResponse = await request(server())
      .post('/invoices')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ milestoneId: contract.milestones[0].id })
      .expect(201);

    const { invoiceId } = body<{ invoiceId: string }>(invoiceResponse);

    // The saga issues asynchronously; wait for it to settle.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await request(server())
        .get(`/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .expect(200);

      const invoice = body<InvoiceDto>(response);
      if (invoice.status === InvoiceStatusDto.ISSUED) return invoice;

      if (Date.now() > deadline) {
        throw new Error(`Invoice ${invoiceId} never reached ISSUED`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function postWebhook(payload: string, signature: string) {
    return request(server())
      .post('/webhooks/stripe')
      .set('stripe-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload);
  }

  async function getInvoice(invoiceId: string, token = tenant.token) {
    const response = await request(server())
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return body<InvoiceDto>(response);
  }

  function countPayments(invoiceId: string) {
    return prisma.forTenant(tenant.tenantId, (tx) =>
      tx.payment.count({ where: { invoiceId } }),
    );
  }

  describe('signature verification', () => {
    it('rejects a payload with no signature header', async () => {
      const invoice = await issuedInvoice(100);

      await request(server())
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send(
          webhookPayload({
            type: 'payment_intent.succeeded',
            amountInCents: 12000,
            tenantId: tenant.tenantId,
            invoiceId: invoice.id,
          }),
        )
        .expect(400);
    });

    it('rejects a forged signature', async () => {
      const invoice = await issuedInvoice(100);
      const payload = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 12000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });

      // Signed with a secret we do not share with the server. Without this
      // check, anyone could mark any invoice paid by POSTing to a public URL.
      await postWebhook(
        payload,
        stripeSignature(payload, 'whsec_an_attacker_secret'),
      ).expect(400);

      expect((await getInvoice(invoice.id)).status).toBe(
        InvoiceStatusDto.ISSUED,
      );
    });

    it('rejects a payload whose body was altered after signing', async () => {
      const invoice = await issuedInvoice(100);
      const payload = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 12000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      const signature = stripeSignature(payload);

      // A genuine signature over different bytes. This is why the raw body has
      // to survive untouched all the way to verification.
      const tampered = payload.replace('12000', '999999');

      await postWebhook(tampered, signature).expect(400);
    });

    it('rejects a signature outside the tolerance window', async () => {
      const invoice = await issuedInvoice(100);
      const payload = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 12000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });

      // Correctly signed, but hours old — replay protection is part of what
      // the signature scheme buys.
      const stale = Math.floor(Date.now() / 1000) - 7200;

      await postWebhook(
        payload,
        stripeSignature(payload, WEBHOOK_SECRET, stale),
      ).expect(400);
    });
  });

  describe('the Definition of Done: replay the same payload three times', () => {
    it('changes nothing after the first delivery', async () => {
      const invoice = await issuedInvoice(1000);
      const payload = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 120000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      const signature = stripeSignature(payload);

      const first = await postWebhook(payload, signature).expect(200);
      expect(body<{ processed: boolean }>(first).processed).toBe(true);

      const afterFirst = await getInvoice(invoice.id);
      expect(afterFirst.status).toBe(InvoiceStatusDto.PAID);
      expect(afterFirst.paidAt).not.toBeNull();

      // Deliveries two and three are acknowledged but must do nothing.
      for (const attempt of [2, 3]) {
        const response = await postWebhook(payload, signature).expect(200);

        expect(
          body<{ received: boolean; processed: boolean }>(response),
        ).toEqual({ received: true, processed: false });
        expect(attempt).toBeGreaterThan(1);
      }

      const afterReplays = await getInvoice(invoice.id);

      // Byte-for-byte identical to the state after the first delivery. Not
      // "still paid" — *unchanged*, including the timestamp, because a
      // re-stamped paidAt would silently rewrite financial history.
      expect(afterReplays).toEqual(afterFirst);

      // And exactly one Payment row, not three.
      expect(await countPayments(invoice.id)).toBe(1);
    });

    it('records the event once in processed_webhooks', async () => {
      const invoice = await issuedInvoice(500);
      const eventId = `evt_dedupe_${randomUUID().replace(/-/g, '')}`;
      const payload = webhookPayload({
        eventId,
        type: 'payment_intent.succeeded',
        amountInCents: 60000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      const signature = stripeSignature(payload);

      await postWebhook(payload, signature).expect(200);
      await postWebhook(payload, signature).expect(200);

      const count = await prisma.processedWebhook.count({ where: { eventId } });
      expect(count).toBe(1);
    });

    it('survives concurrent duplicate deliveries', async () => {
      const invoice = await issuedInvoice(700);
      const payload = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 84000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      const signature = stripeSignature(payload);

      // The case a "have I seen this?" check cannot handle: both requests read
      // the table before either writes. Only the unique constraint decides.
      const responses = await Promise.all([
        postWebhook(payload, signature),
        postWebhook(payload, signature),
        postWebhook(payload, signature),
      ]);

      const processed = responses.filter(
        (response) => body<{ processed: boolean }>(response).processed,
      );

      expect(processed).toHaveLength(1);
      expect(await countPayments(invoice.id)).toBe(1);
      expect((await getInvoice(invoice.id)).status).toBe(InvoiceStatusDto.PAID);
    });
  });

  describe('out-of-order delivery', () => {
    it('does not un-pay an invoice when a stale failure arrives late', async () => {
      const invoice = await issuedInvoice(400);
      const paymentIntentId = `pi_${randomUUID().replace(/-/g, '')}`;

      const success = webhookPayload({
        type: 'payment_intent.succeeded',
        paymentIntentId,
        amountInCents: 48000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      await postWebhook(success, stripeSignature(success)).expect(200);

      const paid = await getInvoice(invoice.id);
      expect(paid.status).toBe(InvoiceStatusDto.PAID);

      // A declined first attempt, delivered after the successful retry.
      // Webhooks carry no ordering guarantee, and this is the case that
      // corrupts data if PAID is not treated as terminal.
      const failure = webhookPayload({
        type: 'payment_intent.payment_failed',
        paymentIntentId: `pi_${randomUUID().replace(/-/g, '')}`,
        amountInCents: 48000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
        failureMessage: 'Your card was declined',
      });
      await postWebhook(failure, stripeSignature(failure)).expect(200);

      const afterLateFailure = await getInvoice(invoice.id);

      expect(afterLateFailure.status).toBe(InvoiceStatusDto.PAID);
      expect(afterLateFailure.paidAt).toBe(paid.paidAt);
      // The stale failure is ignored entirely, not recorded as the invoice's
      // current problem.
      expect(afterLateFailure.lastPaymentError).toBeNull();
    });

    it('a success arriving after a failure still settles the invoice', async () => {
      const invoice = await issuedInvoice(600);

      const failure = webhookPayload({
        type: 'payment_intent.payment_failed',
        amountInCents: 72000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
        failureMessage: 'Insufficient funds',
      });
      await postWebhook(failure, stripeSignature(failure)).expect(200);

      const afterFailure = await getInvoice(invoice.id);
      // A failed attempt is a fact about an attempt, not a state of the
      // invoice — the money is still owed and the client can retry.
      expect(afterFailure.status).toBe(InvoiceStatusDto.ISSUED);
      expect(afterFailure.lastPaymentError).toBe('Insufficient funds');

      const success = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 72000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      await postWebhook(success, stripeSignature(success)).expect(200);

      const afterSuccess = await getInvoice(invoice.id);
      expect(afterSuccess.status).toBe(InvoiceStatusDto.PAID);
      // Cleared on success: a stale error on a paid invoice reads as an
      // unresolved problem.
      expect(afterSuccess.lastPaymentError).toBeNull();
    });
  });

  describe('payment failure', () => {
    it('records the reason and leaves the invoice collectable', async () => {
      const invoice = await issuedInvoice(250);
      const payload = webhookPayload({
        type: 'payment_intent.payment_failed',
        amountInCents: 30000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
        failureMessage: 'Your card has expired',
      });

      await postWebhook(payload, stripeSignature(payload)).expect(200);

      const afterFailure = await getInvoice(invoice.id);
      expect(afterFailure.status).toBe(InvoiceStatusDto.ISSUED);
      expect(afterFailure.lastPaymentError).toBe('Your card has expired');
      expect(afterFailure.paidAt).toBeNull();
    });

    it('is idempotent for failures too', async () => {
      const invoice = await issuedInvoice(275);
      const payload = webhookPayload({
        type: 'payment_intent.payment_failed',
        amountInCents: 33000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
        failureMessage: 'Do not honour',
      });
      const signature = stripeSignature(payload);

      await postWebhook(payload, signature).expect(200);
      const second = await postWebhook(payload, signature).expect(200);

      expect(body<{ processed: boolean }>(second).processed).toBe(false);
      expect(await countPayments(invoice.id)).toBe(1);
    });
  });

  describe('unhandled events', () => {
    it('acknowledges an event type it does not act on', async () => {
      const payload = JSON.stringify({
        id: `evt_${randomUUID().replace(/-/g, '')}`,
        object: 'event',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_123', object: 'subscription' } },
      });

      // Acknowledged, not recorded: a non-2xx would make Stripe retry a type
      // this system will never act on.
      const response = await postWebhook(
        payload,
        stripeSignature(payload),
      ).expect(200);

      expect(body<{ processed: boolean }>(response).processed).toBe(false);
    });
  });

  describe('payment intents', () => {
    it('creates one for an issued invoice, in minor units', async () => {
      const invoice = await issuedInvoice(1000);

      const response = await request(server())
        .post(`/invoices/${invoice.id}/payment-intent`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .expect(200);

      const intent = body<{ paymentIntentId: string; amountInCents: number }>(
        response,
      );

      // 1000 + 20% FR VAT = 1200.00 → 120000 cents, computed from the decimal
      // string rather than `total * 100`, which floats to 119999.99…
      expect(intent.amountInCents).toBe(120000);
      expect(intent.paymentIntentId).toContain('pi_');
    });

    it('refuses to collect twice for an already-paid invoice', async () => {
      const invoice = await issuedInvoice(300);
      const payload = webhookPayload({
        type: 'payment_intent.succeeded',
        amountInCents: 36000,
        tenantId: tenant.tenantId,
        invoiceId: invoice.id,
      });
      await postWebhook(payload, stripeSignature(payload)).expect(200);

      await request(server())
        .post(`/invoices/${invoice.id}/payment-intent`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .expect(409);
    });

    it("forbids collecting on another tenant's invoice", async () => {
      const invoice = await issuedInvoice(150);

      await request(server())
        .post(`/invoices/${invoice.id}/payment-intent`)
        .set('Authorization', `Bearer ${otherTenant.token}`)
        .expect(404);
    });
  });
});
