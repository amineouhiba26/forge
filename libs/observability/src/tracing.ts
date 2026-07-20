import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/**
 * Starts OpenTelemetry tracing for a service.
 *
 * **Must be called before anything else is imported.** Instrumentation works by
 * patching modules as they load — `ioredis`, `pg`, `http` — so a module that
 * was already required is never traced. That is why every `main.ts` calls this
 * first, above the `AppModule` import.
 *
 * Auto-instrumentation covers the boundaries that matter here without a single
 * manual span: the HTTP server at the gateway, the Redis calls that carry both
 * the RPC transport and BullMQ, and every Postgres query. A span per business
 * method would be noise on top of that; the useful ones are where the process
 * boundary is, and those come for free.
 */
export interface Tracing {
  shutdown(): Promise<void>;
}

export function startTracing(serviceName: string): Tracing {
  // Off by default. A collector that is not running makes every service log
  // export failures on a timer, which is worse than no tracing — tests and CI
  // leave it disabled for exactly that reason.
  //
  // Returns a no-op rather than `undefined` so callers never null-check: a
  // shutdown hook guarded by `tracing?.` is one someone eventually deletes.
  if (process.env.OTEL_ENABLED !== 'true') {
    return { shutdown: () => Promise.resolve() };
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      // What distinguishes the five services in the Jaeger UI.
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.1',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem instrumentation produces a span per read — thousands of
        // them at boot, drowning the ones that describe actual work.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Without this, spans buffered at exit are lost — which is precisely when
  // the interesting ones (a crash, a shutdown mid-request) are produced.
  const shutdown = () => {
    void sdk.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return sdk;
}
