/**
 * The deployment-driver registry — the `configure*()` host seam.
 *
 * `cloud-deployment-layer-2026-06-06` P-001 / D-002.
 *
 * `LocalDriver` is always registered (the built-in default), so a fresh process
 * resolves `{ target: 'local' }` with zero host wiring. Cloud backends register
 * via `configureDeployment({ drivers })` (or `registerDeploymentDriver`) at host
 * bootstrap — the same host-seam pattern as `@papercusp/locks`'s `configureLocks`
 * and `@papercusp/host-platform`'s `registerHostPlatform`.
 *
 * Uses a `Symbol.for(...)`-keyed global so a single registry survives ESM/tsx
 * module-forking (the same reason `@papercusp/memory` does — a module-local `Map`
 * would split into per-fork copies and a driver registered in one fork would be
 * invisible in another).
 */
import type { DeploymentConfig, DeploymentDriver, DeploymentTarget } from './types';
import { LocalDriver } from './local-driver';

const REGISTRY_KEY = Symbol.for('@papercusp/deployment-driver:registry');

type Registry = Map<DeploymentTarget, DeploymentDriver>;
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: Registry };

function registry(): Registry {
  const g = globalThis as RegistryGlobal;
  let reg = g[REGISTRY_KEY];
  if (!reg) {
    reg = new Map<DeploymentTarget, DeploymentDriver>();
    reg.set('local', LocalDriver); // the built-in default — always present
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

/**
 * Register one deployment driver (the `configure*()` seam — a cloud backend plugs
 * in here at host bootstrap). Re-registering the same `target` replaces it.
 */
export function registerDeploymentDriver(driver: DeploymentDriver): void {
  registry().set(driver.target, driver);
}

/** Host-seam entry: register a batch of drivers at bootstrap. */
export function configureDeployment(opts: { drivers: DeploymentDriver[] }): void {
  for (const d of opts.drivers) registerDeploymentDriver(d);
}

/**
 * Resolve the driver for a config (defaulting to `local` when the config is
 * absent — every existing harness). Throws a clear error if the target has no
 * registered driver, naming what IS registered.
 */
export function resolveDeploymentDriver(config: DeploymentConfig | undefined | null): DeploymentDriver {
  const target = config?.target ?? 'local';
  const driver = registry().get(target);
  if (!driver) {
    throw new Error(
      `No deployment driver registered for target '${target}'. ` +
        `Registered: [${[...registry().keys()].join(', ')}]. ` +
        `A cloud backend registers via configureDeployment({ drivers }) at host bootstrap.`,
    );
  }
  return driver;
}

/** The set of registered targets (for diagnostics / "what can I deploy to"). */
export function registeredDeploymentTargets(): DeploymentTarget[] {
  return [...registry().keys()];
}

/**
 * Cheap placement check WITHOUT running any driver side effects: does this
 * config's execution plane run on this machine? `local` (or an unregistered
 * target, conservatively) → true; a registered remote driver → false. The
 * launch/orchestrator path (P-004) uses this to decide whether to spawn locally.
 */
export function isLocalDeployment(config: DeploymentConfig | undefined | null): boolean {
  const target = config?.target ?? 'local';
  if (target === 'local') return true;
  const driver = registry().get(target);
  // Unknown target → treat as local (conservative: never silently route work to a
  // frame that isn't wired up; the resolve call will surface the missing driver).
  return driver ? driver.placement === 'local' : true;
}

/** Test-only: reset the registry to just `LocalDriver`. */
export function _resetDeploymentDriversForTests(): void {
  const reg = registry();
  reg.clear();
  reg.set('local', LocalDriver);
}
