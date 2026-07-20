/** One dependency's state, as a service reports it. */
export interface HealthIndicator {
  status: 'up' | 'down';
  message?: string;
}

/** What every service returns for its `*.health.check` pattern. */
export interface ServiceHealthDto {
  service: string;
  status: 'ok' | 'degraded';
  /** Keyed by dependency: `database`, `redis`, `stripe`, … */
  details: Record<string, HealthIndicator>;
  /** Seconds since the process started — a restart loop is visible here. */
  uptimeSeconds: number;
}

/** The gateway's aggregate view across every service. */
export interface AggregateHealthDto {
  status: 'ok' | 'degraded';
  checkedAt: string;
  services: Record<
    string,
    | ServiceHealthDto
    | { service: string; status: 'unreachable'; message: string }
  >;
}
