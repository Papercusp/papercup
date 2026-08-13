/**
 * pot-git/ref-announce-tick.ts — P-202: the RUNTIME DRIVER for ref
 * announcements (p2p-git-live-activation-2026-07-09 P-202).
 *
 * Every piece already exists as a pure library: `ref-announce.ts` (G-3
 * build/verify/accept/handle), `sigrefs.ts` (G-4 build/read/verify),
 * `fetch-transport.ts` (G-2 transport core). NONE of it runs on a schedule
 * yet — this module is that missing tick, composed exactly the way
 * `integrator-tick.ts` (P-203) and `github-bridge-tick.ts` compose their own
 * already-landed legs (D-003: no new scheduler — the caller rides the
 * existing `system:git-sync` tick, mode-gated to `hiveGit.mode != legacy`).
 * Like `integrator-tick.ts`, this module stops at the pure tick: the actual
 * git-sync-action.ts wiring (collecting the fed-event log, persisting the
 * budget-state map, opening the real Protomux stream) is the shared P-205
 * "wiring completeness pass".
 *
 * TWO TICKS, each pure over injected git/transport seams and never-throwing:
 *
 * `runRefAnnouncePublishTick` — run after a local commit:
 *   1. Read the current namespace ref-set (excluding `SIGREFS_REF`) and
 *      compare it against the PRIOR stored sigrefs snapshot's refs (pure
 *      equality) — unchanged ⇒ no-op. Without this check every tick would
 *      rebuild+bump+announce a sigrefs version even when nothing moved,
 *      spamming the hive-wide announce channel on every idle git-sync tick.
 *   2. Changed ⇒ `buildSigrefs` (G-4, auto-incrementing version) then
 *      `buildRefAnnouncement` (G-3). Returns the signed announcement for the
 *      caller to `events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive',
 *      payload }` hive-wide — mirroring how `integrator-tick.ts` returns its
 *      `SignedStagingAdvance` for the caller to emit + persist.
 *
 * `runRefAnnounceReceiveTick` — given the pending inbound announcements the
 * caller collected off the P-009 fed-event log since its watermark (oldest
 * first, one entry per `pot-git:ref-announce` fed_event row not yet
 * processed):
 *   1. Runs `handleRefAnnouncement` per announcement, threading a per-device
 *      budget map (persisted by the caller across ticks — the same idiom
 *      `github-bridge-tick`'s caller persists `last_admitted`) and the
 *      caller's `openStream` transport seam (prod: a per-fetch Protomux
 *      sub-stream on the `papercusp/pot-git` channel — wired separately;
 *      P-201's serve plane is its server half. Tests: a socketpair, exactly
 *      like `ref-announce.integration.test.ts`).
 *   2. A rejected/failed announcement never throws or halts the batch — every
 *      leg reports through the per-announcement result, so one hostile/broken
 *      peer's announcement can never starve the rest of the batch.
 *
 * Never throws — every failure is folded into `errors`; a tick that hits one
 * always still returns its partial results.
 */
import type { Duplex } from 'node:stream';
import { defaultRunGit, type RunGit, listNamespaceRefs, type NamespaceRef, deviceNamespaceKey } from './storage';
import { deriveNamespaceGenesisBaseline } from './namespace-genesis-baseline';
import { SIGREFS_REF, buildSigrefs, readSigrefs } from './sigrefs';
import {
  buildRefAnnouncement,
  handleRefAnnouncement,
  type AnnounceBudgetConfig,
  type AnnounceBudgetState,
  type HandleRefAnnouncementOpts,
  type RefAnnounceHandleResult,
  type SignedRefAnnouncement,
} from './ref-announce';
import {
  checkPublishGuard,
  describePublishRefusal,
  type PublishGuardCaps,
  type PublishGuardResult,
} from './publish-guard';

// ── Publish tick ─────────────────────────────────────────────────────────

export interface RefAnnouncePublishTickInput {
  repoPath: string;
  /** THIS device's identity pubkey (base64) — the announcing device. */
  devicePubkeyBase64: string;
  /** Device signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`). */
  sign: (bytes: Buffer) => Promise<Buffer>;
  nowMs?: number;
  /** Last version this device durably recorded outside the bare store. A cold
   *  join removes the store-local watermark; this floor prevents the rebuilt
   *  device from resetting to v1 and being rejected by peers as rollback. */
  versionFloor?: number;
  runGit?: RunGit;
  /** G-10 own-namespace publish-admission caps (secrets-guard.ts / P-205).
   *  Omit for the module defaults (matches foreign-mirror-quarantine's own
   *  blob-size posture). */
  publishGuardCaps?: PublishGuardCaps;
  /**
   * LAST-RESORT genesis baseline for FIRST-EVER sigrefs, used only when the
   * per-ref walk below cannot answer.
   *
   * ⚠ WI-6251: this is a WORKTREE-derived, SINGLE-BRANCH sha, and this tick
   * judges EVERY ref of this device's namespace in the BARE store. It is the
   * right answer for at most one of them. Relying on it as the primary was the
   * 4GB-heap OOM on the rig — see namespace-genesis-baseline.ts. The tick now
   * derives the baseline PER REF, in the bare store, and falls back to this
   * only when that walk returns nothing.
   */
  genesisBaselineSha?: string | null;
  /** WI-5738: workspace whose runtime secrets-guard path exemptions apply (see
   *  PublishGuardInput.workspaceId). Omitted ⇒ static FIXTURE_FILES only. */
  workspaceId?: string;
}

export interface RefAnnouncePublishTickOutcome {
  ran: boolean;
  /** true when the namespace ref-set changed since the prior sigrefs snapshot
   *  AND every changed ref cleared the publish guard (a fresh sigrefs +
   *  announcement were built this tick). false ⇒ nothing to announce — either
   *  the common no-op case (nothing new under this device's namespace) or a
   *  guard REFUSAL (see `refused`) — check `refused` to tell the two apart. */
  changed: boolean;
  /** Set only when `changed` — the caller MUST emit it hive-wide
   *  (`events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive', payload }`)
   *  and may persist it for observability (mirrors `announcement` on
   *  `IntegratorTickOutcome`). */
  announcement: SignedRefAnnouncement | null;
  /** Set when a changed ref's (fromOid, toOid] range was REFUSED by the G-10
   *  publish guard (secrets / oversized blob / object-flood) — the whole
   *  publish for this tick was skipped (no sigrefs bump, nothing signed,
   *  nothing announced). Namespace-wide, safe to retry next tick: nothing
   *  was exposed. A deliberate refusal, not a transient error — the caller
   *  should log it loudly (`describePublishRefusal`). */
  refused: PublishGuardResult | null;
  errors: string[];
}

function sameRefs(a: readonly NamespaceRef[], b: readonly NamespaceRef[]): boolean {
  if (a.length !== b.length) return false;
  // Both sides are already ref-sorted (listNamespaceRefs / buildSigrefs sort by ref).
  for (let i = 0; i < a.length; i++) {
    if (a[i].ref !== b[i].ref || a[i].sha !== b[i].sha) return false;
  }
  return true;
}

/**
 * ONE publish tick: announce this device's namespace advance IFF it actually
 * advanced since the last stored sigrefs snapshot. Safe to call on every
 * git-sync tick (commit-or-not) — the equality check makes a no-op tick free
 * of any git-object churn or hive-wide chatter.
 */
export async function runRefAnnouncePublishTick(
  input: RefAnnouncePublishTickInput,
): Promise<RefAnnouncePublishTickOutcome> {
  const errors: string[] = [];
  const runGit = input.runGit ?? defaultRunGit;
  const nowMs = input.nowMs ?? Date.now();
  const noop: RefAnnouncePublishTickOutcome = { ran: false, changed: false, announcement: null, refused: null, errors };
  if (
    input.versionFloor !== undefined &&
    (!Number.isSafeInteger(input.versionFloor) || input.versionFloor < 0)
  ) {
    errors.push('versionFloor must be a non-negative safe integer');
    return noop;
  }

  let currentRefs: NamespaceRef[];
  try {
    currentRefs = (await listNamespaceRefs(input.repoPath, input.devicePubkeyBase64, runGit)).filter(
      (r) => r.ref !== SIGREFS_REF,
    );
  } catch (e) {
    errors.push(`listing namespace refs failed: ${e instanceof Error ? e.message : e}`);
    return noop;
  }
  if (currentRefs.length === 0) {
    // Nothing published under this namespace yet — buildRefAnnouncement would
    // throw (no sigrefs to announce). A legitimate no-op, not an error.
    return { ran: true, changed: false, announcement: null, refused: null, errors };
  }

  let prior: { version: number; refs: readonly NamespaceRef[] } | null = null;
  try {
    prior = await readSigrefs(input.repoPath, input.devicePubkeyBase64, runGit);
  } catch (e) {
    // A read failure is NOT "nothing changed" — proceed as if there were no
    // prior snapshot. Worst case: one extra announce; never a missed one.
    errors.push(
      `reading prior sigrefs failed (proceeding as if first-ever snapshot): ${e instanceof Error ? e.message : e}`,
    );
  }
  if (prior && sameRefs(prior.refs, currentRefs) && prior.version >= (input.versionFloor ?? 0)) {
    return { ran: true, changed: false, announcement: null, refused: null, errors };
  }

  // G-10 own-namespace publish guard (publish-guard.ts / P-205): judge every
  // NEW-or-CHANGED ref's (fromOid, toOid] range BEFORE any of it is signed
  // into a sigrefs snapshot or announced hive-wide. One refusal blocks the
  // WHOLE publish this tick — namespace-wide, safe to retry: nothing was
  // exposed under the namespace ref, so a peer can't have fetched it either.
  const priorShaByRef = new Map((prior?.refs ?? []).map((r) => [r.ref, r.sha] as const));
  const namespaceHex = deviceNamespaceKey(input.devicePubkeyBase64);
  for (const r of currentRefs) {
    // Genesis: no prior sigrefs entry for this ref → judge from the verified
    // already-exposed baseline instead of the whole history (see input doc).
    // WI-6251: derive that baseline PER REF and IN THIS STORE — a single
    // worktree-derived sha is the right answer for at most one namespace ref,
    // and is catastrophically wrong for one on a different line of history.
    const fromOid =
      priorShaByRef.get(r.ref) ??
      (await deriveNamespaceGenesisBaseline(
        input.repoPath,
        `refs/namespaces/${namespaceHex}/${r.ref}`,
        namespaceHex,
        runGit,
      )) ??
      input.genesisBaselineSha ??
      null;
    if (fromOid === r.sha) continue; // this ref didn't move (or nothing under it is unexposed)
    let guard: PublishGuardResult;
    try {
      guard = await checkPublishGuard({
        repoPath: input.repoPath,
        fromOid,
        toOid: r.sha,
        caps: input.publishGuardCaps,
        runGit,
        workspaceId: input.workspaceId,
        // WI-5738: SECOND-LINE guard. Everything under this device's namespace
        // got there through own-head-publish, which already enforced the volume
        // caps commit-by-commit one hop earlier. Re-measuring the same bytes as
        // one big range here is double-jeopardy — and because this guard's
        // baseline is SIGREFS (not the namespace ref), a volume refusal here is
        // its own separate terminal ratchet: on 2026-07-20 ref-announce stayed
        // wedged for hours AFTER own-head-publish had been manually unwedged,
        // because re-basing the namespace ref never touched sigrefs. Hard gates
        // (oversized blob / secrets) still refuse — those are safety, not rate.
        volumeGates: 'warn',
      });
    } catch (e) {
      errors.push(`publish guard threw judging ${r.ref} (refusing, fail-closed): ${e instanceof Error ? e.message : e}`);
      return { ran: true, changed: false, announcement: null, refused: null, errors };
    }
    if (!guard.ok) {
      errors.push(`publish guard refused ${r.ref}: ${describePublishRefusal(guard)}`);
      return { ran: true, changed: false, announcement: null, refused: guard, errors };
    }
  }

  try {
    await buildSigrefs(input.repoPath, input.devicePubkeyBase64, input.sign, {
      nowMs,
      versionFloor: input.versionFloor,
      runGit,
    });
    const announcement = await buildRefAnnouncement(input.repoPath, input.devicePubkeyBase64, input.sign, {
      nowMs,
      runGit,
    });
    return { ran: true, changed: true, announcement, refused: null, errors };
  } catch (e) {
    errors.push(`buildSigrefs/buildRefAnnouncement failed: ${e instanceof Error ? e.message : e}`);
    return { ran: true, changed: false, announcement: null, refused: null, errors };
  }
}

// ── Receive tick ─────────────────────────────────────────────────────────

export interface RefAnnounceReceiveTickInput {
  repoPath: string;
  /** Pending inbound announcements collected off the fed-event log since the
   *  caller's watermark, OLDEST FIRST. A stale replay (or an older
   *  announcement superseded by a newer one from the same device later in
   *  this same batch) simply rejects cheaply against the mirror watermark —
   *  no extra client-side dedup needed. */
  pending: readonly SignedRefAnnouncement[];
  selfDevice?: string;
  allowedDevices?: readonly string[];
  /** Per-device budget state, persisted by the caller across ticks (the same
   *  idiom `github-bridge-tick`'s caller persists `last_admitted`). Omitted
   *  device ⇒ first sighting. */
  budgetStates?: ReadonlyMap<string, AnnounceBudgetState | null>;
  budgetConfig?: AnnounceBudgetConfig;
  nowMs?: number;
  /** Open a per-fetch duplex to the ANNOUNCING peer (prod: a Protomux
   *  sub-stream on the `papercusp/pot-git` channel — P-201's serve plane is
   *  its server half; wired separately). Only called when a fetch is
   *  actually needed (mirrors `HandleRefAnnouncementOpts.openStream`). */
  openStream: (peerDevicePubkeyBase64: string) => Promise<Duplex> | Duplex;
  timeoutMs?: number;
  runGit?: RunGit;
}

export interface RefAnnounceReceiveResult {
  device: string;
  version: number;
  result: RefAnnounceHandleResult;
}

export interface RefAnnounceReceiveTickOutcome {
  ran: boolean;
  results: RefAnnounceReceiveResult[];
  /** Updated per-device budget state — the caller MUST persist this as the
   *  new map for the next tick. */
  budgetStates: Map<string, AnnounceBudgetState | null>;
  errors: string[];
}

/**
 * ONE receive tick: process every pending inbound ref-announcement against
 * the local mirror, in order. Never throws; a broken/hostile announcement's
 * result is folded into `results` (rejected/fetch-failed) and the batch
 * continues — one bad peer can never starve the rest.
 */
export async function runRefAnnounceReceiveTick(
  input: RefAnnounceReceiveTickInput,
): Promise<RefAnnounceReceiveTickOutcome> {
  const errors: string[] = [];
  const nowMs = input.nowMs ?? Date.now();
  const budgetStates = new Map(input.budgetStates ?? []);
  const results: RefAnnounceReceiveResult[] = [];
  if (input.pending.length === 0) return { ran: false, results, budgetStates, errors };

  for (const incoming of input.pending) {
    const device = incoming.device_pubkey;
    const opts: HandleRefAnnouncementOpts = {
      selfDevice: input.selfDevice,
      allowedDevices: input.allowedDevices,
      budget: { state: budgetStates.get(device) ?? null, config: input.budgetConfig },
      nowMs,
      openStream: () => input.openStream(device),
      timeoutMs: input.timeoutMs,
      runGit: input.runGit,
    };
    try {
      const result = await handleRefAnnouncement(input.repoPath, incoming, opts);
      budgetStates.set(device, result.budgetState);
      results.push({ device, version: incoming.version, result });
    } catch (e) {
      // handleRefAnnouncement is documented never-throw, but the tick must
      // survive a seam bug (a broken openStream, etc.) without losing the
      // rest of the batch. EI-15335: surface the throw as a `fetch-failed`
      // result (positionally aligned to `pending`, exactly one result per
      // incoming) rather than silently dropping this announcement's slot — a
      // thrown receive is a failed receive, so the caller's cursor logic can
      // hold + re-dial it next tick instead of advancing past a lost announce.
      const stderr = e instanceof Error ? e.message : String(e);
      errors.push(`handleRefAnnouncement(${device.slice(0, 12)}@v${incoming.version}) threw: ${stderr}`);
      results.push({
        device,
        version: incoming.version,
        result: {
          action: 'fetch-failed',
          stderr,
          // A THROWN receive: no git process ran (so no exit status) and this is
          // not the ceiling path. `stderr` already carries the exception message,
          // which is the informative part here.
          timedOut: false,
          code: -1,
          budgetState: budgetStates.get(device) ?? null,
        },
      });
    }
  }
  return { ran: true, results, budgetStates, errors };
}

// ── Receive fed-event cursor decision ─────────────────────────────────────

export interface RefAnnounceReceiveCursorDecision {
  /** The fed-event cursor the caller MUST persist. Held BELOW the oldest
   *  `fetch-failed` row (so the next tick re-reads AND re-dials it) whenever
   *  any announcement's fetch failed; otherwise the full `fallbackCursor`
   *  (advance past everything). */
  cursor: number;
  /** true when the cursor was held back for retry (≥1 fetch-failed). */
  held: boolean;
  /** Ordered fetch-failed rows for the caller to LOG loudly — a transient
   *  transport failure that left the announced namespace UN-mirrored. */
  fetchFailed: { rowId: number; device: string; stderr: string; timedOut: boolean; code: number }[];
}

/**
 * EI-15335 — decide the fed-event cursor after a receive tick.
 *
 * `results` are positionally aligned to the fed-event rows they were built
 * from (one result per pending announcement, in order — the receive tick
 * guarantees this even on a seam-bug throw), and `rowIds[i]` is the
 * `coord_event_log` id that produced `results[i]`.
 *
 * A `fetch-failed` result means the announced namespace was NEVER mirrored (a
 * transient transport failure — e.g. no live swarm dial yet). Advancing the
 * cursor past it drops the announce forever, leaving a silent, permanent
 * namespace-mirror gap until the remote happens to announce again. So we HOLD
 * the cursor just below the OLDEST fetch-failed row: the next tick re-reads it
 * (and every later row) and re-dials. Re-reading later rows is cheap — an
 * already-mirrored success re-rejects as `stale-version` (before the budget is
 * charged), so only the genuinely-failed fetch actually re-dials.
 *
 * Pure + never-throws — a missing/short `results[i]` (defensive) is skipped.
 */
export function decideRefAnnounceReceiveCursor(
  results: readonly (RefAnnounceReceiveResult | undefined)[],
  rowIds: readonly number[],
  fallbackCursor: number,
): RefAnnounceReceiveCursorDecision {
  const fetchFailed: RefAnnounceReceiveCursorDecision['fetchFailed'] = [];
  let oldestFailedRowId: number | null = null;
  for (let i = 0; i < rowIds.length; i++) {
    const res = results[i];
    const rowId = rowIds[i];
    if (!res || rowId === undefined) continue;
    // WI-6418: an `already-in-flight` drive HOLDS the cursor exactly like a
    // failure — the announcement genuinely has not been mirrored yet, and
    // advancing past it would re-create the silent permanent namespace gap this
    // function exists to prevent. But it is NOT added to `fetchFailed`: nothing
    // went wrong, so it must not be logged as a transport error. That
    // distinction is the whole fix — the re-read next tick is now cheap and
    // side-effect-free (the coalescer refuses it without opening a session),
    // instead of opening a rival session that destroyed the transfer already
    // in progress.
    if (res.result.action === 'already-in-flight') {
      if (oldestFailedRowId === null || rowId < oldestFailedRowId) oldestFailedRowId = rowId;
      continue;
    }
    if (res.result.action === 'fetch-failed') {
      // WI-6277: carry the discriminators, not just stderr — a SIGKILLed git
      // (the ceiling path) writes no stderr, so stderr alone renders the one
      // positively-identifiable failure as an empty string.
      fetchFailed.push({
        rowId,
        device: res.device,
        stderr: res.result.stderr,
        timedOut: res.result.timedOut,
        code: res.result.code,
      });
      if (oldestFailedRowId === null || rowId < oldestFailedRowId) oldestFailedRowId = rowId;
    }
  }
  if (oldestFailedRowId === null) return { cursor: fallbackCursor, held: false, fetchFailed };
  return { cursor: Math.min(fallbackCursor, oldestFailedRowId - 1), held: true, fetchFailed };
}
