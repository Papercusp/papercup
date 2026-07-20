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
 * WI-1942 (bounded backfill retry): `backfillLocalState`'s own enqueue-bail cap
 * (backfill-local-state.ts `DEFAULT_ENQUEUE_BAIL_CAP`) can trip on the FIRST boot
 * of any harness whose pre-existing (`*_consolidated` + friends) corpus exceeds
 * the cap — a very common case for an established harness. Before this fix, a
 * bail was silent to this caller (the return value was never inspected) and the
 * ONLY retry path was the NEXT full process boot — an UNBOUNDED wait on a
 * long-running process (hours/days), during which a late-joining peer's
 * pre-existing (historical) content federation never gets enqueued at all, while
 * ongoing (live-tail) writes federate normally via the already-running drain —
 * exactly the "historical entries apply minutes-to-never late, live-tail applies
 * in seconds" asymmetry the bug reported. We now inspect the result and, on a
 * bail, arm a BOUNDED periodic retry (within this same process) that re-attempts
 * the backfill on a fixed cadence until it stops bailing, closing the gap
 * without changing the bail cap's own protective semantics.
 *
 * Extracted as a standalone, dependency-injected helper purely for testability:
 * the production deps default to the real backfill + drain, and the unit test
 * passes fakes (no PG, no swarm). `boot-all.ts` calls
 * `wireOutboxForHarness(handle, pg)` with the defaults.
 */

import type postgres from 'postgres';
import { managedSetInterval } from '@papercusp/scheduled-registry';
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

/** WI-1942 default cadence (ms) for retrying a BAILED backfill within this same
 *  process, instead of only on the next full boot. Deliberately a few minutes —
 *  the bail check runs several COUNT(*) queries across every unswept target, so
 *  this must stay cheap/rare, not a tight poll. */
export const DEFAULT_BACKFILL_RETRY_MS = 2 * 60 * 1000;

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
  /** WI-3684 send-side twin: threaded to `startOutboxDrain`'s `onSessionClosed`
   *  (see outbox-drain.ts) — fires once the drain self-stops on a permanently
   *  closed own-log session, so `ensureSendSideWired` (boot-all.ts) can un-mark
   *  this harness as wired and re-wire on the next boot pass. */
  onSessionClosed?: () => void;
  /** WI-1942: cadence (ms) for retrying a BAILED backfill within this process.
   *  `<= 0` disables the retry (restores the legacy next-boot-only behavior).
   *  Default {@link DEFAULT_BACKFILL_RETRY_MS}. Tests inject a small value +
   *  fake timers to drive it deterministically. */
  backfillRetryMs?: number;
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
      realStartOutboxDrain(h, p, {
        fanout: fanoutOutboxRow,
        epochEncrypt: rekeyDeps?.epochEncrypt,
        onSessionClosed: deps.onSessionClosed,
      }));

  // (1) Best-effort one-time backfill. A failure here must not stop the drain —
  // the backfill catches up rows that PRE-DATE federation; the drain handles
  // every ONGOING write, which is the more important guarantee. The marker is
  // only written on a successful run, so a transient failure re-runs next boot.
  const attemptBackfill = async (): Promise<BackfillResult | null> => {
    try {
      return await backfill(handle, pg);
    } catch (e) {

      console.error(
        `[wire-outbox] backfillLocalState failed for ${handle.workspaceId}::${handle.harnessSlug} ` +
          `(continuing — drain still starts):`,
        e instanceof Error ? e.message : String(e),
      );
      return null;
    }
  };

  const initialResult = await attemptBackfill();

  // WI-1942: a BAIL (candidate corpus over the enqueue cap) previously had no
  // retry within this process — only the next full boot re-attempted it, an
  // unbounded wait during which a late-joining peer never receives pre-existing
  // (historical) content while ongoing writes federate normally. Arm a bounded
  // periodic retry until a re-attempt stops bailing.
  const backfillRetryMs = deps.backfillRetryMs ?? DEFAULT_BACKFILL_RETRY_MS;
  if (initialResult?.bailed && backfillRetryMs > 0) {
    let retrying = false;
    const retryTimer = managedSetInterval(
      `hyperbee-backfill-retry:${handle.workspaceId}:${handle.harnessSlug}`,
      backfillRetryMs,
      () => {
        if (retrying) return; // don't overlap a slow retry with the next tick
        retrying = true;
        void attemptBackfill()
          .then((result) => {
            // Stop once a re-attempt actually ran without bailing (success OR
            // already-skipped) — a thrown/null result keeps retrying.
            if (result && !result.bailed) retryTimer.stop();
          })
          .finally(() => {
            retrying = false;
          });
      },
      { category: 'lifecycle', instanced: true },
    );
    handle.registerCloseHook(() => retryTimer.stop());
  }

  // (2) Start the drain loop.
  const drain = start(handle, pg);

  // (3) Register the stopper as a close-hook so shutdown releases the LISTEN
  // connection + poll timer exactly once (the handle drains its hook set once).
  handle.registerCloseHook(() => drain.stop());

  return drain;
}
