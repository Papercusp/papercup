/**
 * wire-outbox — Stage 5 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * The per-harness boot seam: after a harness boots (boot-all.ts), bring its
 * feature/issue federation send-side fully online:
 *
 *   1. `backfillLocalState(handle, pg)` — one-time enqueue of existing local
 *      `*_consolidated` rows into the outbox (idempotent; the marker makes the
 *      second boot a no-op). BEST-EFFORT: a backfill failure must NOT block the
 *      drain (which federates ongoing writes); it's logged + swallowed.
 *   2. `startOutboxDrain(handle, pg)` — the LISTEN + poll drain loop that appends
 *      undrained outbox rows to the own log.
 *   3. register the drain's `stop()` as a `close()` hook on the handle, so the
 *      LISTEN connection + poll timer release exactly once on teardown without
 *      boot-all tracking a parallel stopper Map.
 *
 * Extracted as a standalone, dependency-injected helper purely for testability:
 * the production deps default to the real backfill + drain, and the unit test
 * passes fakes (no PG, no swarm). `boot-all.ts` calls
 * `wireOutboxForHarness(handle, pg)` with the defaults.
 */

import type postgres from 'postgres';
import type { BootedHarnessHandle } from './boot';
import {
  backfillLocalState as realBackfillLocalState,
  type BackfillResult,
} from './backfill-local-state';
import {
  startOutboxDrain as realStartOutboxDrain,
  type OutboxDrainHandle,
} from './outbox-drain';
import { fanoutOutboxRow } from './fanout-projection';
import { buildHiveRekeyBootDeps } from './hive-epoch-boot-deps';
import { registerPlanClobberNotifier } from './plan-clobber-notify';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

/** System sender for the P-007 plan-clobber notice (mirrors LEARNING_HEALTH_IDENTITY). */
const PLAN_CLOBBER_IDENTITY: AgentIdentity = {
  ownerId: 'plan-clobber-watch',
  ownerLabel: 'plan-clobber-watch',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export interface WireOutboxDeps {
  backfillLocalState?: (
    handle: BootedHarnessHandle,
    pg: postgres.Sql,
  ) => Promise<BackfillResult>;
  startOutboxDrain?: (handle: BootedHarnessHandle, pg: postgres.Sql) => OutboxDrainHandle;
}

/**
 * Wire feature/issue federation send-side for one booted harness. Returns the
 * drain handle (also registered as a `close()` hook so teardown stops it).
 */
export async function wireOutboxForHarness(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  deps: WireOutboxDeps = {},
): Promise<OutboxDrainHandle> {
  // P-007: register the plan-clobber → human-notify listener (idempotent — the
  // clobber emitter is process-global, so a per-harness boot collapses to one
  // listener). A raced plan edit then surfaces a coord notice to the human
  // ("your edit raced X's") instead of a silent LWW loss. Best-effort send.
  registerPlanClobberNotifier((notice) =>
    sendMessage(PLAN_CLOBBER_IDENTITY, {
      to: ['human'],
      summary: notice.summary,
      body: notice.body,
      plan_slug: notice.planSlug,
      category: 'clobber',
    }).then(
      () => {},
      () => {},
    ),
  );

  const backfill = deps.backfillLocalState ?? realBackfillLocalState;
  // Re-key encrypt-on-capture (C-001, shared-hive-rekey-2026-06-19): resolve this
  // hive's re-key boot deps ONCE. Returns null (cheap, flag-first) when the re-key
  // is off / this is a non-hive harness / no local device — so epochEncrypt stays
  // undefined and the drain federates plaintext (byte-identical to today). On an
  // active re-key hive it returns the EpochEncryptCapability the drain encrypts the
  // selected hive-content ops with. A throw (unexpected crypto/device error on an
  // active hive) propagates rather than silently falling back to plaintext — fail
  // safe, never federate post-boundary content in the clear.
  const rekeyDeps = await buildHiveRekeyBootDeps({
    workspaceId: handle.workspaceId,
    harnessSlug: handle.harnessSlug,
  });
  // Default drain wires the local subscribe→inject fan-out as a per-row consumer on
  // the SAME drain (coordination-substrate Phase 2) PLUS the re-key encrypt
  // capability (undefined ⇒ plaintext). Tests override startOutboxDrain to opt out.
  const start =
    deps.startOutboxDrain ??
    ((h: BootedHarnessHandle, p: postgres.Sql) =>
      realStartOutboxDrain(h, p, { fanout: fanoutOutboxRow, epochEncrypt: rekeyDeps?.epochEncrypt }));

  // (1) Best-effort one-time backfill. A failure here must not stop the drain —
  // the backfill catches up rows that PRE-DATE federation; the drain handles
  // every ONGOING write, which is the more important guarantee. The marker is
  // only written on a successful run, so a transient failure re-runs next boot.
  try {
    await backfill(handle, pg);
  } catch (e) {
     
    console.error(
      `[wire-outbox] backfillLocalState failed for ${handle.workspaceId}::${handle.harnessSlug} ` +
        `(continuing — drain still starts):`,
      e instanceof Error ? e.message : String(e),
    );
  }

  // (2) Start the drain loop.
  const drain = start(handle, pg);

  // (3) Register the stopper as a close-hook so shutdown releases the LISTEN
  // connection + poll timer exactly once (the handle drains its hook set once).
  handle.registerCloseHook(() => drain.stop());

  return drain;
}
