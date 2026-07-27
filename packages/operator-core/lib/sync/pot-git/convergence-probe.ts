/**
 * convergence-probe — does `ok:true` actually mean CONVERGED WITH THE POT?
 * (WI-6372, fix D; the class-level closure of WI-6364's fix C.)
 *
 * ## The defect this exists to detect
 * `bootstrapFromPeer` returns `ok:true` when a fetch COMPLETED. Nothing in the
 * bootstrap leg ever asks the only question that matters: is our mirror level
 * with the pot? So a joiner served a complete, internally-consistent pack from
 * a FROZEN store reports "COLD JOIN COMPLETE", stamps
 * `routines.metadata->'bootstrap'` `ok:true`, and every artifact a release
 * reviewer reads says GREEN. That is precisely how WI-6364 survived 7 silent
 * days on the P-302 rig: fix C stopped the superseded store ANSWERING, but any
 * other stale-yet-consistent answer would have read as success exactly the same
 * way.
 *
 * ## Why the correlator is the ref-announce plane, and why that is trustworthy
 * A signed ref-announcement (`ref-announce.ts`) carries
 * `{ device_pubkey, sigrefs_oid, MONOTONIC version }` and rides the fed-event
 * log keyed on the HIVE — therefore **independent of `repoKey` and of the
 * pot-git transport entirely**. That independence IS the whole point: a repoKey
 * divergence makes the two channels DISAGREE while each looks internally
 * healthy, so the disagreement is a signal no single-channel check can produce.
 * Comparing pot-git against itself can only ever re-confirm its own stale view.
 *
 * THE TEST: for each attested member device D, local `readSigrefs(repoPath, D)
 * .version` versus the highest signature-VERIFIED announced version for D.
 * Local behind announced, PERSISTENTLY, = NOT CONVERGED — however many fetches
 * returned ok.
 *
 * ## Pure logic only
 * Mirrors this directory's established split (`federation-probe.ts` /
 * `federation-probe-store.ts`, `results-receipt.ts`): no PG, no git, no ambient
 * `Date.now`, so every guard below is unit-testable without a database. The
 * collection + persistence + logging live at the call site in
 * `git-sync-action.ts`, alongside the ref-announce leg's own fed-event read.
 *
 * NOTE: this is deliberately NOT `federation-probe.ts`, which is a different
 * plane — hop receipts for the CONTENT federation pipeline
 * (`harness_shared.federation_probes`), not pot-git ref convergence.
 */

/** How long a device may sit behind WITHOUT LOCAL PROGRESS before the lag is
 *  called NOT CONVERGED. ~3 ticks at the ~5-min git-sync cadence: long enough
 *  that a normally-advancing cold join never trips it, short enough that a
 *  genuinely stuck mirror is named within a quarter hour rather than a week. */
export const DEFAULT_CONVERGENCE_PERSISTENCE_MS = 15 * 60 * 1000;

/** The highest snapshot a device has ANNOUNCED (signature-verified by the
 *  caller before it gets here — see the guard note on {@link judgeConvergence}). */
export interface AnnouncedSnapshot {
  devicePubkeyBase64: string;
  /** The sigrefs monotonic counter (G-4b) carried in the announcement. */
  version: number;
  sigrefsOid?: string;
}

/** What WE currently mirror for a device. */
export interface LocalMirror {
  devicePubkeyBase64: string;
  /** `null` = we hold no sigrefs for this device at all (never seeded it). */
  version: number | null;
}

/** Per-device lag carried ACROSS ticks — the persistence watermark. */
export interface DeviceLagState {
  /** Highest announced version observed at the time of the observation. */
  announced: number;
  /** Our local version at the time of the observation (`null` = not mirrored). */
  local: number | null;
  /** Epoch ms at which this lag was first observed WITHOUT local progress. */
  since: number;
}

/** The persisted map (device pubkey → lag state) round-tripped via routine metadata. */
export type ConvergenceState = Record<string, DeviceLagState>;

export interface LaggingDevice {
  devicePubkeyBase64: string;
  announced: number;
  local: number | null;
  since: number;
  /** How long we have been behind this device with NO local progress. */
  lagMs: number;
  /** true once `lagMs >= persistenceMs` — the loud set. */
  persistent: boolean;
}

export interface ConvergenceVerdict {
  /**
   * `false` ONLY when at least one device is PERSISTENTLY behind. A transient
   * trail (peer announced seconds ago; a cold join still climbing the ladder)
   * is healthy and leaves this `true`.
   */
  converged: boolean;
  /** Every device currently behind — transient AND persistent. */
  behind: LaggingDevice[];
  /** The subset whose lag outlived `persistenceMs`; non-empty ⇒ NOT CONVERGED. */
  notConverged: LaggingDevice[];
  /** How many devices were judgeable at all (attested + has an announcement). */
  judged: number;
  /** The state to persist for the next tick. */
  state: ConvergenceState;
}

export interface JudgeConvergenceInput {
  /**
   * GUARD 1 — the ONLY devices that may be judged: attested hive members,
   * EXCLUDING self. Anything announcing from outside this set is ignored.
   */
  candidateDevicePubkeys: readonly string[];
  /**
   * Announcements, already SIGNATURE-VERIFIED by the caller. Duplicates and
   * replays are fine: the highest version per device wins.
   */
  announced: readonly AnnouncedSnapshot[];
  local: readonly LocalMirror[];
  /** Prior tick's persisted state (`null` on a cold process). */
  priorState: ConvergenceState | null;
  nowMs: number;
  persistenceMs?: number;
}

/**
 * Judge whether our mirror is level with what the pot has ANNOUNCED.
 *
 * The guards are the substance of this function — a convergence detector that
 * cries wolf on a healthy pair is strictly worse than none, because the fleet
 * learns to ignore it and the one true alarm is lost in the noise. They are
 * written first and ordered so a healthy case exits before any lag arithmetic
 * runs:
 *
 *   1. Only devices in `candidateDevicePubkeys` are judged. Drops self (our own
 *      local always equals our own announcement by construction), drops former
 *      members, and drops any unknown/hostile announcer.
 *   2. A device with NO announcement is NEVER judged behind — absence of a
 *      claim is not evidence of lag.
 *   3. `local >= announced` ⇒ converged; any prior lag state for that device is
 *      DROPPED, so a recovered device starts clean.
 *   4. Versions are compared ONLY within the same device. The sigrefs counter is
 *      monotonic PER DEVICE and cross-device comparison is meaningless.
 *   5. Malformed versions are skipped rather than trusted (belt-and-braces with
 *      the caller's signature check — an unsigned `coord_event_log` row must
 *      never be able to pin us NOT-CONVERGED forever).
 *   6. THE ONE THAT MATTERS — the persistence clock keys on LOCAL PROGRESS, not
 *      on behind-ness. A peer that keeps advancing while we trail it by a tick
 *      is HEALTHY and must never trip the alarm, however long it trails; the
 *      broken case is a mirror that does not move AT ALL while the pot runs
 *      ahead. So `since` is carried forward only while our local version is
 *      UNCHANGED, and resets the moment we make any progress. Without this the
 *      detector would eventually fire on every busy, perfectly-healthy pot —
 *      the exact false-positive that would get it disabled.
 */
export function judgeConvergence(input: JudgeConvergenceInput): ConvergenceVerdict {
  const persistenceMs = input.persistenceMs ?? DEFAULT_CONVERGENCE_PERSISTENCE_MS;

  // GUARD 1 — the judgeable set.
  const judgeable = new Set(input.candidateDevicePubkeys);

  // Highest announced version per judgeable device (GUARD 4 + GUARD 5).
  const highestAnnounced = new Map<string, AnnouncedSnapshot>();
  for (const a of input.announced) {
    if (!judgeable.has(a.devicePubkeyBase64)) continue; // GUARD 1
    if (!Number.isInteger(a.version) || a.version < 0) continue; // GUARD 5
    const prev = highestAnnounced.get(a.devicePubkeyBase64);
    if (prev === undefined || a.version > prev.version) highestAnnounced.set(a.devicePubkeyBase64, a);
  }

  const localByDevice = new Map<string, number | null>();
  for (const l of input.local) {
    if (!judgeable.has(l.devicePubkeyBase64)) continue; // GUARD 1
    const v = l.version;
    localByDevice.set(l.devicePubkeyBase64, Number.isInteger(v as number) && (v as number) >= 0 ? v : null);
  }

  const state: ConvergenceState = {};
  const behind: LaggingDevice[] = [];

  // GUARD 2 — iterate the ANNOUNCED set: a device that never announced is
  // never even considered.
  for (const [devicePubkeyBase64, announcement] of highestAnnounced) {
    const announced = announcement.version;
    const local = localByDevice.get(devicePubkeyBase64) ?? null;

    // GUARD 3 — level or ahead ⇒ converged, and the prior lag state is dropped
    // (deliberately NOT copied into `state`).
    if (local !== null && local >= announced) continue;

    // GUARD 6 — the persistence clock tracks LOCAL PROGRESS, not behind-ness.
    const prior = input.priorState?.[devicePubkeyBase64];
    const localUnchanged = prior !== undefined && prior.local === local;
    const since = localUnchanged ? prior.since : input.nowMs;

    // Clamp: a `since` in the future (clock skew, or metadata restored from
    // another machine) must read as "no lag yet", never as instant failure.
    const lagMs = Math.max(0, input.nowMs - since);

    const entry: LaggingDevice = {
      devicePubkeyBase64,
      announced,
      local,
      since,
      lagMs,
      persistent: lagMs >= persistenceMs,
    };
    behind.push(entry);
    state[devicePubkeyBase64] = { announced, local, since };
  }

  behind.sort((a, b) => b.lagMs - a.lagMs);
  const notConverged = behind.filter((d) => d.persistent);

  return {
    converged: notConverged.length === 0,
    behind,
    notConverged,
    judged: highestAnnounced.size,
    state,
  };
}

/**
 * One-line human summary for the tick log. Says WHICH device, HOW far behind,
 * and FOR HOW LONG — the three facts a debugger otherwise has to reconstruct
 * from a cross-machine log read.
 */
export function formatConvergenceVerdict(verdict: ConvergenceVerdict): string {
  if (verdict.judged === 0) return 'no announced peer snapshots to compare against yet';
  if (verdict.converged && verdict.behind.length === 0) {
    return `converged with ${verdict.judged} announced peer snapshot(s)`;
  }
  const describe = (d: LaggingDevice): string =>
    `${d.devicePubkeyBase64.slice(0, 8)} local ${d.local === null ? 'ABSENT' : `v${d.local}`} < announced v${d.announced}` +
    ` (${Math.round(d.lagMs / 60_000)}m without local progress)`;
  if (verdict.converged) {
    return `trailing (healthy, still advancing): ${verdict.behind.map(describe).join('; ')}`;
  }
  return `NOT CONVERGED: ${verdict.notConverged.map(describe).join('; ')}`;
}
