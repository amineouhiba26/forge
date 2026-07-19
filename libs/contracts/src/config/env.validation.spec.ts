import {
  gatewayEnvSchema,
  tenantsServiceEnvSchema,
  workerServiceEnvSchema,
} from './env.validation';

describe('env validation schemas', () => {
  const validRedis = { REDIS_HOST: 'localhost', REDIS_PORT: 6379 };
  const validDb = {
    DATABASE_URL: 'postgresql://forge:forge@localhost:5433/forge?schema=public',
  };

  describe('gatewayEnvSchema', () => {
    it('defaults PORT and NODE_ENV when they are absent', () => {
      const result = gatewayEnvSchema.validate(validRedis);

      // `ValidationResult` is a union whose error branch types `value` as
      // `any`, so it has to be narrowed explicitly to stay type-checked.
      expect(result.error).toBeUndefined();
      const value = result.value as { PORT: number; NODE_ENV: string };

      expect(value.PORT).toBe(3000);
      expect(value.NODE_ENV).toBe('development');
    });

    it('rejects a port outside the valid TCP range', () => {
      const { error } = gatewayEnvSchema.validate({
        ...validRedis,
        PORT: 70000,
      });

      expect(error?.message).toContain('PORT');
    });
  });

  describe('tenantsServiceEnvSchema', () => {
    it('accepts a complete environment', () => {
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        ...validDb,
      });

      expect(error).toBeUndefined();
    });

    it('rejects a non-postgres DATABASE_URL', () => {
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        DATABASE_URL: 'mysql://forge:forge@localhost:3306/forge',
      });

      expect(error?.message).toContain('DATABASE_URL');
    });

    it('reports every invalid var at once, not just the first', () => {
      const { error } = tenantsServiceEnvSchema.validate(
        { REDIS_HOST: 'localhost', REDIS_PORT: 'not-a-port' },
        { abortEarly: false },
      );

      // This is the behaviour that makes a bad .env one restart to fix
      // instead of one restart per broken variable.
      expect(error?.details).toHaveLength(2);
      expect(error?.message).toContain('REDIS_PORT');
      expect(error?.message).toContain('DATABASE_URL');
    });
  });

  describe('workerServiceEnvSchema', () => {
    it('does not require DATABASE_URL — the worker owns no tables', () => {
      const { error } = workerServiceEnvSchema.validate(validRedis);

      expect(error).toBeUndefined();
    });
  });
});
