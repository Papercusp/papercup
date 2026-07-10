/**
 * idempotentRegisterWorkflow — a globalThis-cached guard around DBOS.registerWorkflow
 * (WI-3830, 2026-07-10 critical incident).
 *
 * `DBOS.registerWorkflow` is called at MODULE TOP LEVEL across this codebase's dbos/
 * workflow files (`export const xWorkflow = DBOS.registerWorkflow(impl, { name, ... })`).
 * DBOS's own registry is a process-wide SINGLETON keyed by name: the SDK's decorators.js
 * throws `DBOSConflictingRegistrationError` ("Operation (Name: ...) is already
 * registered.") the second time the SAME name is registered from a DIFFERENT
 * registration object — which is exactly what happens if the module executes a SECOND
 * time within one process's lifetime (a require-cache hot-reload, a duplicate module
 * resolution path, or any other route to a second top-level evaluation of the same
 * file). Because the registration happens at module top level, that throw takes down
 * the WHOLE module load — and every unrelated consumer that imports it — with it. This is
 * exactly what WI-3830 hit: `featurePipelineWorkflow`'s registration failed on a (still
 * unconfirmed) second load, and because `startFeaturePipeline` (used by BOTH
 * `fleet:place_batch` and a plain `cup:spawn`) imports this same module, EVERY fresh
 * cup/bee spawn broke fleet-wide — not just the one workflow.
 *
 * Fix: cache the FIRST registration's result on `globalThis` — shared across every
 * module instance in one process/V8 realm regardless of how many times a given file
 * specifier gets re-evaluated (the standard Node idiom for a hot-reload-safe singleton,
 * e.g. the Prisma Client global-cache pattern). A second load in the SAME process
 * reuses the cached handle instead of calling `DBOS.registerWorkflow` again — so
 * `DBOS.registerWorkflow` runs AT MOST ONCE per name per process, and a double-load can
 * no longer hard-crash the registration path.
 *
 * Scope note: this is wired into `orchestrator-workflow.ts`'s `featurePipelineWorkflow`
 * (the reported call site) first. The SAME module-level-registration shape appears in
 * ~13 other dbos/*.ts files (periodic-workflows.ts alone has ~30 registrations) — each
 * is an instance of the SAME latent class, but migrating all of them is a larger,
 * separately-reviewed follow-up (filed WI-3831), not bundled into this incident fix.
 */
import type { WorkflowConfig, FunctionName } from '@dbos-inc/dbos-sdk';

type GlobalRegistry = typeof globalThis & { __papercuspDbosWorkflowCache__?: Map<string, unknown> };

function registryCache(): Map<string, unknown> {
  const g = globalThis as GlobalRegistry;
  if (!g.__papercuspDbosWorkflowCache__) g.__papercuspDbosWorkflowCache__ = new Map();
  return g.__papercuspDbosWorkflowCache__;
}

/**
 * Register a DBOS workflow at most once per process, per `key`. `key` should be the
 * workflow's registered `name` (or another value stable across re-loads of the same
 * source file) — NOT derived from anything that changes per load (e.g. a timestamp).
 *
 * Usage (replaces a bare `DBOS.registerWorkflow(impl, config)` call):
 *   export const fooWorkflow = idempotentRegisterWorkflow('foo', () =>
 *     DBOS.registerWorkflow(fooImpl, { name: 'foo', ...config }),
 *   );
 */
export function idempotentRegisterWorkflow<This, Args extends unknown[], Return>(
  key: string,
  register: () => (this: This, ...args: Args) => Promise<Return>,
): (this: This, ...args: Args) => Promise<Return> {
  const cache = registryCache();
  const cached = cache.get(key);
  if (cached) return cached as (this: This, ...args: Args) => Promise<Return>;
  const registered = register();
  cache.set(key, registered);
  return registered;
}

// Re-exported so a call site's `config` object type-checks against the real DBOS types
// without importing them separately (keeps the usage example above self-contained).
export type { WorkflowConfig, FunctionName };
