#!/usr/bin/env node
/**
 * Load test for the invoice creation path.
 *
 * The backlog's framing is the point: *"know your actual throughput ceiling,
 * don't guess"*. This measures the path Sprint 3 built — the CQRS command,
 * two cross-service RPCs, a tax calculation and a database write — under
 * concurrency.
 *
 * **autocannon rather than k6**, which the backlog offers as the alternative:
 * k6 is a separate Go binary that CI would have to install, and its scripts
 * are written in a JavaScript dialect that is not this project's. autocannon
 * is a dev dependency that runs with `node`, so this stays one `npm` command.
 * k6 wins for distributed load generation and richer thresholds; neither
 * matters at the scale of a single-machine ceiling check.
 *
 *   node scripts/load-test.mjs                    # read path
 *   node scripts/load-test.mjs --path=invoices    # invoice creation
 *
 * Requires the stack running (`docker compose up -d` and the five services).
 */

import autocannon from 'autocannon';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 10);

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};

const scenario = arg('path', 'read');

async function json(path, options = {}) {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });

  if (!response.ok) {
    throw new Error(`${path} → ${response.status} ${await response.text()}`);
  }

  return response.json();
}

/**
 * Every run creates its own tenant.
 *
 * Reusing one would measure a database that grows across runs, so numbers
 * would drift downward for reasons unrelated to the code.
 */
async function seed() {
  const run = Date.now();

  const auth = await json('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      tenant: { name: `Load ${run}`, country: 'FR' },
      owner: { email: `load-${run}@acme.test`, password: 'a-long-password-x' },
    }),
  });

  const token = auth.tokens.accessToken;
  const authHeader = { Authorization: `Bearer ${token}` };

  const client = await json('/clients', {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({ name: 'Load Client', email: `lc-${run}@x.test` }),
  });

  return { token, authHeader, clientId: client.id, run };
}

/**
 * Pre-creates completed milestones, one per request the run will make.
 *
 * A milestone can only be invoiced once — the unique constraint from Sprint 3
 * — so hammering one would measure the *conflict* path (409s) rather than
 * invoice creation. Every request needs its own.
 */
async function prepareMilestones({ authHeader, clientId }, count) {
  const milestones = [];

  for (let i = 0; i < count; i += 1) {
    const contract = await json('/contracts', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({
        clientId,
        title: `Load contract ${i}`,
        milestones: [{ title: 'W', amount: 100, dueDate: '2026-09-01' }],
      }),
    });

    await json(`/contracts/${contract.id}`, {
      method: 'PATCH',
      headers: authHeader,
      body: JSON.stringify({ status: 'ACTIVE' }),
    });

    const milestoneId = contract.milestones[0].id;
    await json(`/contracts/${contract.id}/milestones/${milestoneId}/complete`, {
      method: 'PATCH',
      headers: authHeader,
    });

    milestones.push(milestoneId);
  }

  return milestones;
}

function report(title, result) {
  const pct = (n) => `${n.toFixed(0)}ms`;

  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
  console.log(`   requests   ${result.requests.total} in ${result.duration}s`);
  console.log(`   throughput ${result.requests.average.toFixed(1)} req/s`);
  console.log(
    `   latency    p50 ${pct(result.latency.p50)}  p97.5 ${pct(result.latency.p97_5)}  max ${pct(result.latency.max)}`,
  );
  console.log(
    `   errors     ${result.errors}   non-2xx ${result.non2xx}   timeouts ${result.timeouts}`,
  );

  // A run where most responses were errors measures the error path, not the
  // feature — and would otherwise look like excellent throughput.
  if (result.non2xx > result.requests.total * 0.05) {
    console.log(
      `\n   ⚠  ${result.non2xx} non-2xx responses — these numbers describe failures, not work.`,
    );
  }
}

const context = await seed();

if (scenario === 'invoices') {
  // Bounded by how many milestones can be prepared in reasonable time; the
  // run stops when they are exhausted rather than degenerating into 409s.
  const total = Number(arg('count', '150'));
  process.stdout.write(`Preparing ${total} completed milestones…`);
  const milestones = await prepareMilestones(context, total);
  process.stdout.write(' done\n');

  let index = 0;

  const result = await autocannon({
    url: GATEWAY,
    connections: CONNECTIONS,
    amount: total,
    headers: {
      'Content-Type': 'application/json',
      ...context.authHeader,
    },
    requests: [
      {
        method: 'POST',
        path: '/invoices',
        setupRequest: (request) => ({
          ...request,
          body: JSON.stringify({ milestoneId: milestones[index++] }),
        }),
      },
    ],
  });

  report('POST /invoices (CQRS command → 2 RPCs → insert)', result);
} else {
  const result = await autocannon({
    url: GATEWAY,
    connections: CONNECTIONS,
    duration: DURATION,
    headers: context.authHeader,
    requests: [{ method: 'GET', path: '/contracts?limit=20' }],
  });

  report('GET /contracts (query side, paginated)', result);
}
