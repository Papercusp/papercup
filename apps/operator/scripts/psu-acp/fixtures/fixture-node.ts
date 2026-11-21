import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const referenceSidecar = process.env.PSU_ACP_HEADLESS_SIDECAR || '/usr/lib/Papercusp Server/sidecar';

/** Use the distribution's Linux runtime inside the minimal image. The Node
 * running Vitest can have dynamic dependencies that only exist on the host. */
export function fixtureNode(): string {
  if (process.env.PSU_ACP_TEST_NODE) return process.env.PSU_ACP_TEST_NODE;
  const bundled = join(referenceSidecar, 'bin', 'node');
  return process.env.PSU_ACP_HEADLESS_SIDECAR || existsSync(bundled) ? bundled : process.execPath;
}
