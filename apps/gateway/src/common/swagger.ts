import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Where the UI and the raw document are served. */
export const SWAGGER_PATH = 'docs';

/**
 * Mounts the OpenAPI document and Swagger UI.
 *
 * Gated behind `SWAGGER_ENABLED` rather than always on. A full description of
 * every route, parameter and error shape is a convenience for a reviewer and a
 * map for an attacker; which of those matters depends on whether the API is
 * public, so the decision belongs in configuration rather than in code. The
 * default is on, because an undocumented API is the more common failure.
 *
 * Schemas are inferred by the `@nestjs/swagger` CLI plugin (wired in
 * `nest-cli.json`), which reads the existing `class-validator` decorators. The
 * DTOs are therefore documented without a parallel set of `@ApiProperty`
 * decorators that could drift out of step with the validation that is actually
 * enforced.
 */
export function setupSwagger(app: INestApplication): boolean {
  const config = app.get(ConfigService);

  if (!config.get<boolean>('SWAGGER_ENABLED')) {
    return false;
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Forge API')
      .setDescription(
        'Multi-tenant freelance contract and invoicing platform.\n\n' +
          'Every route except `/auth/*`, `/health` and the Stripe webhook ' +
          'requires a bearer access token. Tenant scoping is taken from the ' +
          'token and enforced by Postgres row-level security, so a token can ' +
          'only ever reach its own tenant’s data.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        // Named so `@ApiBearerAuth('access-token')` reads meaningfully at a
        // controller, and so the UI's authorise button is unambiguous.
        'access-token',
      )
      .addTag('auth', 'Signup, login, refresh and logout')
      .addTag('clients', 'Clients a tenant works for')
      .addTag('contracts', 'Contracts and their milestones')
      .addTag('invoices', 'Invoice creation and payment collection')
      .addTag('health', 'Liveness and dependency checks')
      .build(),
  );

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    // Keeps the authorise token across reloads, so a reviewer pastes it once.
    swaggerOptions: { persistAuthorization: true },
    jsonDocumentUrl: `${SWAGGER_PATH}-json`,
  });

  return true;
}
