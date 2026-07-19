import {
  gatewayEnvSchema,
  tenantsServiceEnvSchema,
  workerServiceEnvSchema,
} from './env.validation';

describe('env validation schemas', () => {
  const validRedis = { REDIS_HOST: 'localhost', REDIS_PORT: 6379 };
  const validDb = {
    DATABASE_URL:
      'postgresql://forge_app:forge_app@localhost:5433/forge?schema=public',
  };
  // Long enough to satisfy the 32-character minimum, and distinct from each
  // other — the schema rejects reuse of one secret for both.
  const validSecrets = {
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
  };

  describe('gatewayEnvSchema', () => {
    it('defaults PORT and NODE_ENV when they are absent', () => {
      const result = gatewayEnvSchema.validate({
        ...validRedis,
        JWT_ACCESS_SECRET: validSecrets.JWT_ACCESS_SECRET,
      });

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
        JWT_ACCESS_SECRET: validSecrets.JWT_ACCESS_SECRET,
        PORT: 70000,
      });

      expect(error?.message).toContain('PORT');
    });

    it('does not require the refresh secret — the gateway never issues tokens', () => {
      const { error } = gatewayEnvSchema.validate({
        ...validRedis,
        JWT_ACCESS_SECRET: validSecrets.JWT_ACCESS_SECRET,
      });

      expect(error).toBeUndefined();
    });
  });

  describe('tenantsServiceEnvSchema', () => {
    it('accepts a complete environment', () => {
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        ...validDb,
        ...validSecrets,
      });

      expect(error).toBeUndefined();
    });

    it('rejects a non-postgres DATABASE_URL', () => {
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        ...validSecrets,
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
      expect(error?.message).toContain('REDIS_PORT');
      expect(error?.message).toContain('DATABASE_URL');
      expect(error?.message).toContain('JWT_ACCESS_SECRET');
      expect(error?.details.length).toBeGreaterThan(1);
    });

    it('rejects a JWT secret short enough to brute-force offline', () => {
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        ...validDb,
        JWT_ACCESS_SECRET: 'short',
        JWT_REFRESH_SECRET: validSecrets.JWT_REFRESH_SECRET,
      });

      expect(error?.message).toContain('JWT_ACCESS_SECRET');
    });

    it('rejects reusing one secret for both access and refresh tokens', () => {
      // If they match, a refresh token also verifies as an access token, and
      // the short access-token TTL stops bounding anything.
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        ...validDb,
        JWT_ACCESS_SECRET: 'c'.repeat(48),
        JWT_REFRESH_SECRET: 'c'.repeat(48),
      });

      expect(error?.message).toContain('JWT_REFRESH_SECRET');
    });

    it('rejects a TTL that is not a duration', () => {
      const { error } = tenantsServiceEnvSchema.validate({
        ...validRedis,
        ...validDb,
        ...validSecrets,
        JWT_ACCESS_TTL: '15 minutes',
      });

      expect(error?.message).toContain('JWT_ACCESS_TTL');
    });
  });

  describe('workerServiceEnvSchema', () => {
    it('does not require DATABASE_URL — the worker owns no tables', () => {
      const { error } = workerServiceEnvSchema.validate(validRedis);

      expect(error).toBeUndefined();
    });
  });
});
