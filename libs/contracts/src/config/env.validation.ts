import * as Joi from 'joi';

/**
 * Env validation schemas.
 *
 * The rule from the backlog is that an app must **crash on missing or invalid
 * env vars** rather than boot into a half-configured state. `ConfigModule`
 * validates against these at module-init, so a typo'd `REDIS_PORT` fails the
 * process immediately instead of surfacing as a timeout under load later.
 *
 * Composed rather than one big schema: a service should only declare the vars
 * it actually reads, so an unused-but-missing var never blocks a boot.
 */

/**
 * A duration such as `15m`, `7d` or `3600s`.
 *
 * `DurationString` is the type-level counterpart: together they mean a value
 * that passed this schema can be used where the type is expected without a
 * cast that hides a lie.
 */
export type DurationString = `${number}${'s' | 'm' | 'h' | 'd'}`;

const DURATION = Joi.string()
  .pattern(/^\d+[smhd]$/)
  .messages({
    'string.pattern.base':
      '{{#label}} must be a number followed by s, m, h or d (e.g. "15m").',
  });

/** Every app needs these. */
const baseSchema = {
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
};

/** Any app that speaks the Redis microservice transport. */
const redisTransportSchema = {
  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().required(),
};

/** Any app that owns Prisma-managed tables. */
const databaseSchema = {
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql'] })
    .required(),
};

/**
 * Anything that *verifies* an access token. The minimum length is not
 * decoration: HS256 security rests entirely on the secret's entropy, and a
 * short one is brute-forceable offline from a single captured token.
 */
const accessTokenSchema = {
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
};

/** Anything that *issues* tokens — today only tenants-service. */
const tokenIssuerSchema = {
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .required()
    .invalid(Joi.ref('JWT_ACCESS_SECRET'))
    .messages({
      'any.invalid':
        'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET, otherwise a ' +
        'refresh token is a valid access token and the short access TTL is ' +
        'meaningless.',
    }),
  // Short by design: an access token cannot be revoked, so its lifetime is the
  // window in which a revoked session still works.
  //
  // The pattern is enforced, not merely documented — `parseDuration` and the
  // JWT library both expect this exact shape, and a value like "15 minutes"
  // would otherwise fail deep inside token signing rather than at boot.
  JWT_ACCESS_TTL: DURATION.default('15m'),
  JWT_REFRESH_TTL: DURATION.default('7d'),
};

export const gatewayEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
  // The gateway verifies access tokens but never issues them, so it has no
  // business holding the refresh secret.
  ...accessTokenSchema,
  PORT: Joi.number().port().default(3000),
});

export const tenantsServiceEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
  ...databaseSchema,
  ...accessTokenSchema,
  ...tokenIssuerSchema,
});

export const contractsServiceEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
  ...databaseSchema,
});

export const billingServiceEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
  ...databaseSchema,
});

export const workerServiceEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
});
