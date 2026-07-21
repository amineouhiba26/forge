import { stopInfrastructure } from './containers';
import type { TestInfrastructure } from './containers';

export default async function globalTeardown(): Promise<void> {
  const infrastructure = (globalThis as { __INFRA__?: TestInfrastructure })
    .__INFRA__;

  if (infrastructure) {
    await stopInfrastructure(infrastructure);
  }
}
