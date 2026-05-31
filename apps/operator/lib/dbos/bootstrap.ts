/**
 * DBOS Transact bootstrap — Phase 0 of `dbos-durable-jobs-2026-05-31`.
 *
 * Boots DBOS durable execution against the operator's embedded Postgres.
 * The call site (instrumentation-node.ts) gates this behind
 * `PAPERCUSP_DBOS_ENABLE=1` (default OFF) — same shape as the other
 * opt-in boot workers (`PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE`,
 * `PAPERCUSP_IPC_ENABLE`). The PostHog `flags:*` A/B gate (plan D-011)
 * comes in Phase 1 with the AutoLoop runtime migration; the boot launch
 * itself stays env-gated so we never block startup on an async flag read.
 *
 * Verified end-to-end in the Phase-0 gate (P-002) against an
 * embedded-postgres-server PG 16 instance:
 *  - DBOS creates its `dbos` schema and runs/resumes workflows.
 *  - An unpinned application-version change leaves prior workflows PENDING
 *    (the D-008 hazard) — hence the pinned `applicationVersion` below.
 *  - A completed step is not re-executed on resume.
 *
 * Design (see the plan):
 *  - D-002: resolve the DSN via `getHarnessAdminUrlWithSource()`; never
 *    hardcode a port. Refuse the native-fallback so we don't point DBOS at
 *    the dead `:5432/papercusp_legacy` when the desktop isn't running.
 *  - DBOS system tables live in a dedicated `dbos` schema.
 *  - D-008 / D-012: pin the application version so timer workflows recover
 *    across app updates. Override per-deploy with `DBOS__APPVERSION`.
 *  - Functional API (`registerWorkflow` / `runStep`), not decorators — the
 *    operator transpiles under tsx/esbuild (:3070) and Next/SWC (:3055),
 *    which handle decorators inconsistently.
 */
import { getHarnessAdminUrlWithSource } from '@/lib/embedded-pg-discovery';

const PINNED_APP_VERSION = process.env.DBOS__APPVERSION || 'papercusp-jobs-v1';

const G = globalThis as unknown as { __papercuspDbosStarted?: boolean };

/** Idempotent single launch. Safe across Next HMR re-registers. */
export async function startDbos(): Promise<void> {
  if (G.__papercuspDbosStarted) return;

  const { url, source } = getHarnessAdminUrlWithSource();
  // Probe the resolved PG before launching. The source label can't distinguish
  // a *dead* native-fallback (desktop product: :5432 is the retired
  // papercusp_legacy) from a *live* one (dev box: :5432 IS the operator DB) —
  // so connect-test instead: launch when reachable, skip cleanly when not.
  {
    const postgres = (await import('postgres')).default;
    const probe = postgres(url, { max: 1, connect_timeout: 5, prepare: false });
    try {
      await probe`SELECT 1`;
    } catch (err) {
      console.warn(
        `[dbos] resolved PG not reachable (source=${source}) — skipping DBOS launch:`,
        err instanceof Error ? err.message : err,
      );
      await probe.end({ timeout: 2 }).catch(() => {});
      return;
    }
    await probe.end({ timeout: 2 }).catch(() => {});
  }

  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({
    name: 'papercusp-operator',
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: PINNED_APP_VERSION,
    // The operator shares a box with Restart (shop-api binds :3001); DBOS's
    // admin server defaults to :3001 and would EADDRINUSE. We don't use it.
    runAdminServer: false,
  });

  // Register workflows BEFORE launch so recovery + the scheduler can bind them.
  await import('./hello-workflow');
  if (process.env.PAPERCUSP_DBOS_AUTOLOOP === '1') {
    // Phase 1: AutoLoop as a scheduled workflow + dedup-keyed fire queue
    // (D-011 flag-gated; the legacy setInterval ticker stands down).
    await import('./autoloop-workflow');
  }
  if (process.env.PAPERCUSP_DBOS_TIMERS === '1') {
    // Phase 2: simple periodic timers (telemetry flush, scratch GC, …) as
    // scheduled workflows; their legacy setInterval workers stand down.
    await import('./periodic-workflows');
  }

  await DBOS.launch();
  G.__papercuspDbosStarted = true;
  console.log(
    `[dbos] launched (schema=dbos, source=${source}, appVersion=${PINNED_APP_VERSION})`,
  );
}
