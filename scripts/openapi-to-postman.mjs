#!/usr/bin/env node
//
// Generates a Postman collection from the gateway's own OpenAPI document.
//
//   node scripts/openapi-to-postman.mjs                 # fetches from a running gateway
//   node scripts/openapi-to-postman.mjs spec.json       # or reads a saved spec
//
// Generated rather than hand-written on purpose: a hand-maintained collection
// drifts from the API the moment a route changes, and a collection that lies is
// worse than none. This one is derived from the same document Swagger UI serves,
// which is itself derived from the class-validator decorators the code enforces.
//
// Two things are added that OpenAPI cannot express on its own:
//   - an auth flow: login writes {{accessToken}} into the environment, so every
//     other request is authorised without pasting a token by hand;
//   - realistic example bodies, so a request can be sent as-is rather than
//     after filling in six placeholder fields.

import { writeFileSync, readFileSync } from 'node:fs';

const SOURCE = process.argv[2];
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const OUTPUT = process.env.OUTPUT ?? 'docs/forge.postman_collection.json';

/** Bodies worth sending. Keyed by `METHOD /path` as OpenAPI names it. */
const EXAMPLES = {
  'POST /auth/signup': {
    tenant: { name: 'Acme Studio', country: 'FR' },
    owner: { email: 'owner@acme.test', password: 'a-long-enough-password' },
  },
  'POST /auth/login': {
    tenantId: '{{tenantId}}',
    email: 'owner@acme.test',
    password: 'a-long-enough-password',
  },
  'POST /auth/refresh': { tenantId: '{{tenantId}}', refreshToken: '{{refreshToken}}' },
  'POST /auth/logout': { tenantId: '{{tenantId}}', refreshToken: '{{refreshToken}}' },
  'POST /clients': {
    name: 'Wayne Enterprises',
    email: 'pay@wayne.test',
    companyName: 'Wayne Corp',
  },
  'PATCH /clients/{id}': { name: 'Wayne Enterprises Ltd' },
  'POST /contracts': {
    clientId: '{{clientId}}',
    title: 'Website rebuild',
    description: 'Design and build',
    currency: 'EUR',
    milestones: [
      { title: 'Design', amount: 2500.5, dueDate: '2026-09-01' },
      { title: 'Build', amount: 7000, dueDate: '2026-10-15' },
    ],
  },
  'PATCH /contracts/{id}': { status: 'ACTIVE' },
  'POST /invoices': { milestoneId: '{{milestoneId}}' },
};

/**
 * Scripts that capture ids from a response into collection variables, so the
 * requests can be run top to bottom as a working flow rather than individually
 * with hand-copied values.
 */
const CAPTURES = {
  'POST /auth/signup': [
    'const b = pm.response.json();',
    'pm.collectionVariables.set("accessToken", b.tokens.accessToken);',
    'pm.collectionVariables.set("refreshToken", b.tokens.refreshToken);',
    'pm.collectionVariables.set("tenantId", b.user.tenantId);',
  ],
  'POST /auth/login': [
    'const b = pm.response.json();',
    'pm.collectionVariables.set("accessToken", b.tokens.accessToken);',
    'pm.collectionVariables.set("refreshToken", b.tokens.refreshToken);',
  ],
  'POST /auth/refresh': [
    'const b = pm.response.json();',
    'pm.collectionVariables.set("accessToken", b.tokens.accessToken);',
    'pm.collectionVariables.set("refreshToken", b.tokens.refreshToken);',
  ],
  'POST /clients': [
    'pm.collectionVariables.set("clientId", pm.response.json().id);',
  ],
  'POST /contracts': [
    'const b = pm.response.json();',
    'pm.collectionVariables.set("contractId", b.id);',
    'pm.collectionVariables.set("milestoneId", b.milestones[0].id);',
  ],
  'POST /invoices': [
    'pm.collectionVariables.set("invoiceId", pm.response.json().invoiceId);',
  ],
};

/** Path parameter -> collection variable, so `:id` resolves to something real. */
const PATH_VARIABLES = {
  '/clients/{id}': { id: '{{clientId}}' },
  '/contracts/{id}': { id: '{{contractId}}' },
  '/contracts/{id}/milestones': { id: '{{contractId}}' },
  '/contracts/{id}/milestones/{milestoneId}/complete': {
    id: '{{contractId}}',
    milestoneId: '{{milestoneId}}',
  },
  '/invoices/{id}': { id: '{{invoiceId}}' },
  '/invoices/{id}/payment-intent': { id: '{{invoiceId}}' },
  '/users/{id}': { id: '{{userId}}' },
};

async function loadSpec() {
  if (SOURCE) return JSON.parse(readFileSync(SOURCE, 'utf8'));

  const response = await fetch(`${BASE_URL}/docs-json`);
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${BASE_URL}/docs-json (${response.status}). ` +
        'Start the gateway, or pass a saved spec as an argument.',
    );
  }
  return response.json();
}

/** `/contracts/{id}/milestones` -> path segments Postman understands. */
function toPostmanPath(path) {
  return path.split('/').filter(Boolean).map((s) => s.replace(/^\{(.+)\}$/, ':$1'));
}

function buildRequest(path, method, operation) {
  const key = `${method.toUpperCase()} ${path}`;
  const isPublic = path.startsWith('/auth') || path.startsWith('/webhooks') ||
    path.startsWith('/health') || path === '/ping';

  const query = (operation.parameters ?? [])
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name,
      value: '',
      // Disabled so the request is valid as sent; enable to use the filter.
      disabled: true,
      description: p.description ?? p.schema?.type ?? '',
    }));

  const variables = Object.entries(PATH_VARIABLES[path] ?? {}).map(
    ([k, v]) => ({ key: k, value: v }),
  );

  const request = {
    method: method.toUpperCase(),
    header: [{ key: 'Content-Type', value: 'application/json' }],
    url: {
      raw: `{{baseUrl}}${path}`,
      host: ['{{baseUrl}}'],
      path: toPostmanPath(path),
      ...(query.length ? { query } : {}),
      ...(variables.length ? { variable: variables } : {}),
    },
    description: operation.description ?? operation.summary ?? '',
  };

  // Public routes carry no Authorization header; everything else inherits the
  // collection-level bearer auth.
  if (isPublic) request.auth = { type: 'noauth' };

  if (EXAMPLES[key]) {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(EXAMPLES[key], null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  const item = {
    name: operation.summary || `${method.toUpperCase()} ${path}`,
    request,
    response: [],
  };

  if (CAPTURES[key]) {
    item.event = [
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: CAPTURES[key] },
      },
    ];
  }

  return item;
}

/** Groups by the first tag, falling back to the first path segment. */
function folderFor(path, operation) {
  const tag = operation.tags?.[0];
  if (tag) return tag;
  return path.split('/').filter(Boolean)[0] ?? 'other';
}

const spec = await loadSpec();

const folders = new Map();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;

    const name = folderFor(path, operation);
    if (!folders.has(name)) folders.set(name, []);
    folders.get(name).push(buildRequest(path, method, operation));
  }
}

// Auth first — nothing else works until a token exists.
const ORDER = ['auth', 'clients', 'contracts', 'invoices', 'users', 'health'];
const ordered = [...folders.entries()].sort(
  (a, b) =>
    (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99) ||
    a[0].localeCompare(b[0]),
);

const collection = {
  info: {
    name: 'Forge API',
    description:
      `${spec.info.description ?? ''}\n\n` +
      'Generated from the gateway OpenAPI document by ' +
      '`scripts/openapi-to-postman.mjs` — regenerate rather than edit by hand.\n\n' +
      'Run the requests top to bottom: **Signup** stores the access token and ' +
      'tenant id, **Create client** stores the client id, and so on, so every ' +
      'later request resolves its variables automatically.',
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
  },
  item: ordered.map(([name, items]) => ({ name, item: items })),
  variable: [
    { key: 'baseUrl', value: BASE_URL },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'tenantId', value: '' },
    { key: 'clientId', value: '' },
    { key: 'contractId', value: '' },
    { key: 'milestoneId', value: '' },
    { key: 'invoiceId', value: '' },
    { key: 'userId', value: '' },
  ],
};

writeFileSync(OUTPUT, `${JSON.stringify(collection, null, 2)}\n`);

const count = ordered.reduce((n, [, items]) => n + items.length, 0);
console.log(`Wrote ${OUTPUT}`);
console.log(`  ${ordered.length} folders, ${count} requests`);
for (const [name, items] of ordered) console.log(`   ${name}: ${items.length}`);
