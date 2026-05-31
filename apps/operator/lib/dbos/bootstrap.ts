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
  if (source === 'native-fallback') {
    console.warn(
      '[dbos] refusing to launch against the native-fallback PG (no embedded-pg discovery — desktop not running). Skipping.',
    );
    return;
  }

  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({
    name: 'papercusp-operator',
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: PINNED_APP_VERSION,
  });

  // Register workflows BEFORE launch so recovery can re-bind them.
  await import('./hello-workflow');

  await DBOS.launch();
  G.__papercuspDbosStarted = true;
  console.log(
    `[dbos] launched (schema=dbos, source=${source}, appVersion=${PINNED_APP_VERSION})`,
  );
}
