/**
 * owner-roster-rebind-refold-snapshot.test.ts
 *
 * Brief 11 (federation-release-hardening) — the SINGLE code-review follow-up on the
 * A-003 roster-rebind `forceReFold` fix: the SNAPSHOT-COMPACTION × re-fold interaction.
 *
 * ## What this guards
 * The A-003 fix (boot.ts) recovers a dropped owner `hive_members` roster op like this:
 * a rekey rebind sets `forceReFold`; `mergeOnePass` consumes it by RESETTING the merge
 * cursor (`mergeCursor = createMergeCursor()`, boot.ts ~L1481) so every admitted log
 * re-folds through the freshly hive-home-bound projection. The owner-roster-rebind-race
 * repro (`owner-roster-rebind-race.repro.integration.test.ts`) proves that end-to-end
 * over a real boot with snapshot compaction OFF (fold-from-0).
 *
 * BUT the very next line after the reset is snapshot seeding:
 *   if (snapshotEnabled) await seedCursorFromSnapshots(logs, mergeCursor);  // boot.ts ~L1491
 * With the `papercusp-substrate-log-snapshot` flag ON, that seeds the just-reset cursor
 * at each log's LATEST snapshot index — so the re-fold no longer starts at 0; it starts
 * at the snapshot, SKIPPING the individual roster op that lives in the summarized prefix.
 * The code-review question (Brief 11): does the re-fold STILL re-apply the dropped roster
 * op when the flag is on? It should — a snapshot op summarizes all current rows, so the
 * roster row re-applies via the SNAPSHOT even though its individual op is skipped. This
 * test proves exactly that, and must land BEFORE the log-compaction/snapshot flag ships.
 *
 * ## Why this layer (direct-drive, not a second full boot)
 * The interaction is a pure composition of three functions boot.ts's `mergeOnePass` calls
 * in order — `createMergeCursor()` (the forceReFold reset) → `seedCursorFromSnapshots()` →
 * `mergeAdmittedLogsIncremental()`. Driving them directly (as the sibling
 * `schema-skew-snapshot-recovery.test.ts` drives the analogous snapshot-recovery property)
 * is STRICTLY more precise than a full boot for the claim under test: it lets us assert the
 * re-fold seeds PAST the individual roster op's index, so the row it re-applies could ONLY
 * have come from the snapshot summary — the exact thing the review flagged. A full boot only
 * observes that the row landed, not that the snapshot was its source.
 *
 * ## The home=<none> drop, modeled
 * The real drop is projections/hive-members.ts writeToPg (`row.hive_home_slug !== harnessSlug`
 * while the projection is still MEMBER-slug-bound at home=<none>) plus the member-content-guard
 * dropping the owner's content until the roster resolves. Both manifest as "the op does not
 * land while bound to the member slug". The binding-aware sink here is a faithful behavioral
 * stand-in: an op targeting a slug other than the currently-bound one returns false (dropped).
 * The property under test is the fold/cursor/snapshot MECHANISM, not the PG predicate.
 *
 * ## Teeth
 *  - The NO-RESET arm re-folds the same (un-reset) cursor with the now-home-bound sink and
 *    asserts the roster STILL does not land — because after the home=<none> pass the cursor
 *    is already past the snapshot AND the winner was recorded (applyRecordingWinner records
 *    the winner even on a dropped apply). So recovery is IMPOSSIBLE without the forceReFold
 *    reset. Reverting the reset (boot.ts ~L1481) would make the real fix regress exactly here.
 *  - The FIX arm asserts the reset cursor re-seeds at the snapshot index (> the roster op's
 *    index) and that indices below the snapshot are NEVER re-read during the re-fold — so the
 *    roster row is provably re-applied via the snapshot summary, not its individual op.
 *
 * RUN (unit layer — pure functions + in-memory fakes, no PG/Docker):
 *   cd packages/operator-core && npx vitest run \
 *     lib/sync/hyperbee/__tests__/owner-roster-rebind-refold-snapshot.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  seedCursorFromSnapshots,
  createMergeCursor,
  type AdmittedLog,
  type MergeCursor,
} from '../read-merge';
import { buildSnapshotOp } from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

const HIVE_HOME = 'rrr-owner-hive'; // the owner's harness slug IS the hive home (the roster op's target)
const MEMBER_SLUG = 'rrr-joined-owner-hive'; // B's fresh-joiner member slug (the home=<none> binding)
const OWNER_USER = 99;
const FEATURE_ID = 'F-owner-rrr';
const AUTHOR = 'a'.repeat(64); // the owner's log key (source of the roster + content ops)

/** An in-memory `AdmittedLog` that records every index read, so a test can assert
 *  which ops a fold/seed actually touched. Mirrors the sibling repros' `fakeLog`. */
function recordingLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog & { reads: number[] } {
  const reads: number[] = [];
  return {
    keyHex,
    reads,
    get length() {
      return ops.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      reads.push(i);
      return ops[i] ?? null;
    },
  };
}

/** A single-writer `put` carrying its projection TARGET slug in `value`, exactly as
 *  the real ops do: a `hive_members` roster row keys on `hive_home_slug`; a `work_items`
 *  content row keys on `harness_slug`. */
function rosterPut(ts: number): PeerLogOp {
  return {
    type: 'put',
    table: 'hive_members',
    hbKey: String(OWNER_USER),
    value: { hive_home_slug: HIVE_HOME, github_user_id: OWNER_USER, github_username: 'owner' },
    ts,
    schema_version: 1,
    author_pubkey: AUTHOR,
  } as PeerLogOp;
}
function contentPut(ts: number): PeerLogOp {
  return {
    type: 'put',
    table: 'work_items',
    hbKey: FEATURE_ID,
    value: { harness_slug: HIVE_HOME, feature_id: FEATURE_ID, title: 'owner feature' },
    ts,
    schema_version: 1,
    author_pubkey: AUTHOR,
  } as PeerLogOp;
}

/** The projection-binding-aware apply sink. While bound to `boundSlug`, an op whose
 *  TARGET slug (hive_home_slug for the roster / harness_slug for content) differs is
 *  DROPPED (returns false) — the behavioral stand-in for the home=<none> member-slug
 *  drop (projections/hive-members.ts writeToPg) + the member-content-guard. Records
 *  every op that actually LANDS under `boundSlug`. */
function bindingSink(boundSlug: string) {
  const landed: Array<{ table: string; hbKey: string }> = [];
  const applyImpl = async (op: OpEnvelope): Promise<boolean> => {
    const v = (op.value ?? {}) as { hive_home_slug?: string; harness_slug?: string };
    const target = op.table === 'hive_members' ? v.hive_home_slug : v.harness_slug;
    if (target !== boundSlug) return false; // dropped — bound to a different slug
    landed.push({ table: op.table!, hbKey: op.hbKey! });
    return true;
  };
  return { landed, applyImpl };
}

const hasRoster = (landed: Array<{ table: string; hbKey: string }>) =>
  landed.some((r) => r.table === 'hive_members' && r.hbKey === String(OWNER_USER));

/** The owner's log carrying a snapshot that summarizes the roster + content ops:
 *    index 0 = roster put, index 1 = content put, index 2 = snapshot covering [0,2).
 *  The individual roster op (index 0) lives in the summarized prefix, so a
 *  snapshot-seeded re-fold (cursor at index 2) skips it — recovery must come from the
 *  snapshot summary. */
const PREFIX: PeerLogOp[] = [rosterPut(100), contentPut(200)];
const SNAP_INDEX = PREFIX.length; // 2
const OWNER_OPS: PeerLogOp[] = [
  ...PREFIX,
  buildSnapshotOp({ ops: PREFIX, coversUpTo: PREFIX.length, author_pubkey: AUTHOR, ts: 300, schema_version: 1 }),
];

describe('Brief 11 — A-003 forceReFold re-fold × snapshot compaction: the reset+seed still re-applies the dropped owner hive_members roster op', () => {
  it(
    'SNAPSHOT ON: home=<none> drops the roster; the forceReFold reset + seedCursorFromSnapshots re-applies it VIA the snapshot summary (cursor seeded past the individual op) — and WITHOUT the reset it can never recover',
    async () => {
      const log = recordingLog(AUTHOR, OWNER_OPS);

      // ── Phase 1 — home=<none> (member-slug bound). boot.ts mergeOnePass with
      //    snapshotEnabled: fresh cursor → seedCursorFromSnapshots → fold. ──
      let cursor: MergeCursor = createMergeCursor();
      await seedCursorFromSnapshots([log], cursor, { getTimeoutMs: 0 });
      // Seeding positions the fresh cursor AT the snapshot (past the individual roster op).
      expect(cursor.positions.get(AUTHOR)).toBe(SNAP_INDEX);

      const member = bindingSink(MEMBER_SLUG);
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: member.applyImpl, getTimeoutMs: 0 });
      // The roster op targets HIVE_HOME, not the member slug → DROPPED. B's roster stays empty.
      expect(hasRoster(member.landed), 'pre-rekey: the owner roster op MUST NOT land under the member-slug binding').toBe(false);
      // The cursor advanced past the snapshot (caught up), and the winner was recorded on the
      // dropped apply — so a naive re-fold on THIS cursor is now impossible (proved next).
      expect(cursor.positions.get(AUTHOR)).toBe(OWNER_OPS.length);

      // ── Phase 2a — TEETH: rekey WITHOUT the forceReFold reset. Re-fold the SAME cursor
      //    with the now-hive-home-bound sink. Nothing folds (cursor is past everything) and
      //    the winner is already recorded → the roster can NEVER re-apply. This is exactly the
      //    state the forceReFold reset exists to escape; reverting boot.ts ~L1481 regresses here. ──
      const homeNoReset = bindingSink(HIVE_HOME);
      const noReset = await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: homeNoReset.applyImpl,
        getTimeoutMs: 0,
      });
      expect(noReset.applied, 'without the cursor reset the re-fold folds nothing (cursor already past the log)').toBe(0);
      expect(hasRoster(homeNoReset.landed), 'without the forceReFold reset the roster op can never re-apply').toBe(false);

      // ── Phase 2b — THE FIX (boot.ts mergeOnePass on rekey, snapshotEnabled):
      //    forceReFold reset → seedCursorFromSnapshots → re-fold through the rebound projection. ──
      cursor = createMergeCursor(); // boot.ts ~L1481 — the one-shot forceReFold reset
      log.reads.length = 0; // watch exactly which indices the reset re-fold touches
      await seedCursorFromSnapshots([log], cursor, { getTimeoutMs: 0 }); // boot.ts ~L1491
      // The reset cleared the positions, so seeding re-engages and lands AT the snapshot —
      // PAST the individual roster op's index (0). The row can only come from the snapshot.
      expect(cursor.positions.get(AUTHOR)).toBe(SNAP_INDEX);
      expect(SNAP_INDEX).toBeGreaterThan(0); // the seeded cursor truly skips the individual roster op

      const home = bindingSink(HIVE_HOME);
      const refold = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: home.applyImpl, getTimeoutMs: 0 });

      // RECOVERY: the roster row re-applies under the hive-home binding — from the SNAPSHOT.
      expect(hasRoster(home.landed), 'post-rekey: the forceReFold reset + snapshot seeding MUST re-apply the dropped owner roster op').toBe(true);
      expect(refold.applied, 'the re-fold applied the snapshot-summarized rows').toBeGreaterThan(0);
      // PROVENANCE: the re-fold read ONLY the snapshot op (index 2). The individual roster op
      // (index 0) and content op (index 1) were never re-read — so the roster row was re-applied
      // SOLELY via the snapshot summary, exactly as Brief 11 claims.
      expect(log.reads).not.toContain(0);
      expect(log.reads).not.toContain(1);
      expect(log.reads).toContain(SNAP_INDEX);
    },
  );

  it(
    'SNAPSHOT OFF (baseline): the forceReFold reset folds from 0 and re-applies the dropped roster op via its individual op — the flag changes the mechanism, not the outcome',
    async () => {
      const log = recordingLog(AUTHOR, OWNER_OPS);

      // Phase 1 — home=<none>, snapshot seeding OFF ⇒ NO seedCursorFromSnapshots call ⇒ fold from 0.
      let cursor: MergeCursor = createMergeCursor();
      expect(cursor.positions.get(AUTHOR) ?? 0).toBe(0);
      const member = bindingSink(MEMBER_SLUG);
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: member.applyImpl, getTimeoutMs: 0 });
      expect(hasRoster(member.landed)).toBe(false);

      // Phase 2 — forceReFold reset, snapshot OFF ⇒ fresh cursor folds from index 0, so the
      // INDIVIDUAL roster op (index 0) re-applies directly (no snapshot needed).
      cursor = createMergeCursor();
      const home = bindingSink(HIVE_HOME);
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: home.applyImpl, getTimeoutMs: 0 });
      expect(hasRoster(home.landed), 'flag-OFF: fold-from-0 re-applies the roster op via its own index').toBe(true);
    },
  );
});
