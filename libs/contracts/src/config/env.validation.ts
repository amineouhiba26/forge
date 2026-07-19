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

export const gatewayEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
  PORT: Joi.number().port().default(3000),
});

export const tenantsServiceEnvSchema = Joi.object({
  ...baseSchema,
  ...redisTransportSchema,
  ...databaseSchema,
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
