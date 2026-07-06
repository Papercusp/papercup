/**
 * replication-stall-ei — durable EI escalation for replication-stall episodes.
 *
 * Plan: shared-hive-p2p-release-readiness-2026-07-03 P-004 (WI-1840). The
 * registry verdict (replication-liveness.ts) and the boot-history event are
 * both PROCESS-LOCAL — they evaporate on restart and are visible only to
 * whoever polls a status surface. P-004's acceptance requires the stall to
 * ESCALATE: this module files a durable `engineer_issues` row (an EI) so a
 * connected-but-dead peer shows up in the fleet's triage queue even when
 * nobody is watching.
 *
 * Dedup: at most ONE OPEN EI per (harness, log, kind) — episodes are already
 * edge-triggered once per stall episode, but a process restart re-arms the
 * detector, and a permanent stall (the P-059/WI-183 shape) would otherwise
 * re-file on every reboot. Open-EI title match + a per-process in-flight
 * guard keep it single.
 *
 * Runs in whichever process runs the merge loop. Both the default (main
 * process) and the `papercusp-substrate-sidecar` mode have PG access (the
 * sidecar owns the merge loop's PG projections when the flag is ON).
 * Best-effort everywhere: escalation must never wedge the merge pass.
 */

import type { ReplicationStallEpisode } from './replication-liveness';

export const REPLICATION_LIVENESS_TOPIC = 'replication-liveness';

/**
 * The EI surface also escalates the outbox-drain detectors — same durable-EI +
 * dedup mechanism, same triage topic; the "logKeyHex" slot carries a log key as
 * the stable dedup identifier:
 *   - 'drain_stalled' (WI-2009) — a single drain pass HUNG past the watchdog
 *     timeout; logKeyHex = the harness's LIVE own-log key;
 *   - 'drain_backlog_stalled' (WI-2009) — passes SETTLE but drain zero rows for the
 *     whole no-progress window while mapped undrained rows wait (the original filed
 *     silent-permanence signature the hung-pass watchdog does not cover); logKeyHex
 *     = the harness's LIVE own-log key;
 *   - 'drain_orphan_tail' (WI-2136) — fed-scope rows were drained into a PRIOR-era
 *     own-log key that no longer matches the live log (the own-log keypair did not
 *     persist across a restart — WI-2105 class), so that era's unreplicated tail is
 *     stranded; logKeyHex = the DEAD prior-era key (so distinct dead eras page
 *     separately).
 */
export type StallEiEpisode = Omit<ReplicationStallEpisode, 'kind'> & {
  kind:
    | ReplicationStallEpisode['kind']
    | 'drain_stalled'
    | 'drain_backlog_stalled'
    | 'drain_orphan_tail';
};

/** Stable, dedup-able title for one (harness, log, kind). */
export function replicationStallEiTitle(episode: {
  harnessSlug: string;
  logKeyHex: string;
  kind:
    | 'no_replicator'
    | 'frozen'
    | 'connected_never_replicated'
    | 'drain_stalled'
    | 'drain_backlog_stalled'
    | 'drain_orphan_tail';
}): string {
  return (
    `[replication-liveness] ${episode.kind}: harness=${episode.harnessSlug} ` +
    `log=${episode.logKeyHex.slice(0, 12)}… (WI-183 class)`
  );
}

/** Resolver identity stamped on auto-resolved (recovered) replication-stall EIs. */
export const RECOVERY_OWNER = 'system:replication-liveness';

/** DI seam so the dedup+file logic unit-tests without PG. */
export interface ReplicationStallEiDeps {
  listOpenByTopic(topic: string): Promise<Array<{ id: string; title: string }>>;
  create(input: {
    title: string;
    body: string;
    severity: 'major';
    source: 'engineer';
    kind: 'bug';
    topics: string[];
    createdBy: string;
    foundDuring: string;
  }): Promise<{ id: string }>;
  /** EI-7110: resolve a previously-filed EI once its stall has recovered. */
  resolve(id: string, note: string): Promise<void>;
}

async function defaultDeps(): Promise<ReplicationStallEiDeps> {
  const m = await import('../../issues-engineer');
  return {
    listOpenByTopic: (topic) =>
      m.listIssues({ state: 'open', topic, limit: 100 }),
    create: (input) => m.createIssue(input),
    resolve: async (id, note) => {
      await m.setIssueState(id, 'resolved', RECOVERY_OWNER, note);
    },
  };
}

/** Per-process in-flight/filed guard (second dedup layer under racing passes). */
const inFlight = new Set<string>();

/** Test seam. */
export function _resetReplicationStallEiForTests(): void {
  inFlight.clear();
}

/**
 * File a durable EI for a stall episode, deduplicating against open EIs with
 * the same stable title. Returns the EI id when filed, null when deduped or on
 * failure (best-effort — the caller never awaits this on the merge path).
 */
export async function fileReplicationStallEi(
  episode: StallEiEpisode,
  deps?: ReplicationStallEiDeps,
): Promise<string | null> {
  const title = replicationStallEiTitle(episode);
  if (inFlight.has(title)) return null;
  // Vitest safety gate (EI-6987): replication-liveness.ts fires this as an
  // unawaited best-effort side effect of the merge pass — including from a
  // UNIT TEST that boots a real (test-scoped) substrate handle to exercise
  // the stall-DETECTION logic (boot.test.ts's 'ws-stall-1'/'s-stall-1'
  // fixture), not the EI-filing path. Without a deps override that hit
  // defaultDeps()'s REAL createIssue() against production PG, filing a
  // severity:major escalation from test fixture data straight into the real
  // backlog. A test that DOES want to exercise real filing passes its own
  // `deps` (the existing DI seam below) to opt back in — mirrors the same
  // gate in cache/cached-read.ts.
  if (process.env.VITEST && !deps) return null;
  inFlight.add(title);
  try {
    const d = deps ?? (await defaultDeps());
    const open = await d.listOpenByTopic(REPLICATION_LIVENESS_TOPIC);
    if (open.some((i) => i.title === title)) return null; // already escalated
    const created = await d.create({
      title,
      body:
        `Replication-liveness detector (P-004 / WI-1840, WI-183 class): ${episode.detail}\n\n` +
        `workspace=${episode.workspaceId} harness=${episode.harnessSlug}\n` +
        `log_core_key=${episode.logKeyHex}\n` +
        `kind=${episode.kind} stalledForMs=${episode.stalledForMs}\n\n` +
        `Meaning: ${
          episode.kind === 'drain_stalled'
            ? 'the OUTBOX DRAIN pass for this harness exceeded its watchdog timeout — a hung await ' +
              '(keychain unwrap / epoch-key resolution / append) wedged the serialized drain loop, so ' +
              'NO local writes were federating (WI-2009 permanence class). The watchdog un-wedged the ' +
              'loop (a fresh pass re-attempts; duplicate appends are safe per the at-least-once contract), ' +
              'but the underlying hang needs a root-cause look (WI-2018 keychain identity is the known suspect).'
            : episode.kind === 'drain_backlog_stalled'
            ? 'the OUTBOX DRAIN for this harness has run its passes but drained ZERO rows for the whole ' +
              'no-progress window while mapped undrained rows remain queued — passes complete (no hang) yet ' +
              'make no forward progress, so local writes are silently NOT federating (WI-2009 filed ' +
              'signature: fail-fast every pass, e.g. a persistent EpochKeyUnavailableError because the ' +
              'epoch key never arrived [WI-2003 divergence], or a persistent append fault). The 5s poll ' +
              'keeps re-attempting; this EI turns the otherwise silent console-spam into a durable page. ' +
              'Root-cause: check whether this device holds the current epoch key (hive_epoch_keys) and ' +
              'whether appends are landing on the own log.'
            : episode.kind === 'drain_orphan_tail'
            ? 'the OUTBOX DRAIN drained fed-scope rows into a PRIOR-era own-log key (log_core_key above) ' +
              'that no longer matches the live process’s log — the own-log keypair did NOT persist across ' +
              'a restart (WI-2105 / WI-2136 class: e06b8704 era → 4072cfad era), so that dead era’s ' +
              'unreplicated tail is STRANDED: its blocks can never replicate because no live process holds ' +
              'the dead log’s keypair. Recovery is runbook-only per the GO/NO-GO (d)-clause — re-emit ' +
              'the stranded rows by setting drained_at=NULL for the dead-key rows so the next drain ' +
              're-appends them onto the LIVE log (at-least-once tolerates the duplicate). Root fix ' +
              '(WI-2136 Q1): persist the own-log keypair across restarts so the class disappears; this ' +
              'guard then stays silent and pins it against regression. NB: two live keys at once instead ' +
              'of a restart succession is the WI-1891 cross-process host race (P-059) — also worth paging.'
            : `the swarm-level connection may look healthy (peer_connected), but this ` +
              `admitted remote log is ${
                episode.kind === 'no_replicator'
                  ? 'no longer carried by any live replicator session — its writer’s ops are NOT arriving'
                  : 'attached to a replicator but ingesting nothing — the writer is ahead and no ops have merged for the whole grace window'
              }. Writes made on that peer are silently diverging until replication recovers.`
        }\n\n` +
        `Triage: check \`getReplicationLiveness()\` (federation status / dogfood-substrate-status) ` +
        `for the current verdict; see agent-insights/shared-hive-federation-diagnosis-toolkit for the rig probes. ` +
        `This EI auto-dedupes per (harness, log, kind) while one stays open.`,
      severity: 'major',
      source: 'engineer',
      kind: 'bug',
      topics: [REPLICATION_LIVENESS_TOPIC, 'federation'],
      createdBy: 'system:replication-liveness',
      foundDuring: 'replication-liveness-detector',
    });
    return created.id;
  } catch {
    return null; // best-effort: the registry verdict still surfaces the stall
  } finally {
    // Keep the guard for the process lifetime ONLY on success/dedup? No —
    // release it so a transient PG failure can retry on the NEXT episode
    // (episodes are edge-triggered, so this is at most once per re-arm).
    inFlight.delete(title);
  }
}

/** The (harness, log, kind) identity resolveReplicationStallEi needs to find
 *  the EI a recovered episode should close — the same fields replicationStallEiTitle
 *  keys on, plus a human-readable `detail` for the resolution note. */
export type RecoveredStallEpisode = Pick<StallEiEpisode, 'harnessSlug' | 'logKeyHex' | 'kind' | 'detail'>;

/**
 * EI-7110: auto-resolve the durable EI a stall episode filed, once
 * `sampleReplicationLiveness` observes the SAME (harness, log, kind) recover.
 * Without this, a filed EI never auto-clears — it sits open until a human/agent
 * manually re-verifies current live status and closes it (exactly the toil that
 * surfaced EI-7110 itself: a fleet member 20h downstream of the stall, unable to
 * cheaply confirm whether it had already self-healed).
 *
 * Resolves EVERY open EI matching the stable (harness, log, kind) title — not
 * just the first (EI-6772 class). Duplicate open EIs for the SAME condition arise
 * legitimately across the FEDERATED, multi-machine issue ledger: two machines can
 * each file an `origin:remote` EI for one stall before the other's row replicates
 * in, and neither the per-process `inFlight` guard nor a racing `listOpenByTopic`
 * dedup can see the other machine's not-yet-replicated row. A `.find` recovery
 * then closes ONLY one and strands every duplicate open forever — exactly what
 * left EI-6772 open while its sibling EI-7764 (same harness/log/kind, both
 * `origin:remote`) auto-resolved on the same recovery. Returns the ids actually
 * resolved.
 *
 * No-ops (returns `[]`) when no open EI matches the stable dedup title — that is
 * the NORMAL case (recovered before ever crossing the escalation's OWN grace, or
 * already resolved by an earlier recovery). Best-effort: a resolve failure never
 * throws back into the merge pass that calls it (the registry verdict already
 * reads 'live' regardless of whether the durable EI closes) — each EI is resolved
 * independently so one failure never strands its siblings.
 */
export async function resolveReplicationStallEi(
  recovery: RecoveredStallEpisode,
  deps?: ReplicationStallEiDeps,
): Promise<string[]> {
  const title = replicationStallEiTitle(recovery);
  // Same VITEST safety gate as fileReplicationStallEi (EI-6987): a unit test
  // exercising the DETECTION logic with a real reporter (no deps override) must
  // never touch production PG.
  if (process.env.VITEST && !deps) return [];
  try {
    const d = deps ?? (await defaultDeps());
    const open = await d.listOpenByTopic(REPLICATION_LIVENESS_TOPIC);
    const matches = open.filter((i) => i.title === title);
    if (matches.length === 0) return [];
    const resolvedIds: string[] = [];
    for (const match of matches) {
      try {
        await d.resolve(match.id, `auto-resolved: replication recovered — ${recovery.detail}`);
        resolvedIds.push(match.id);
      } catch {
        /* per-EI best-effort: one resolve failure must not strand its siblings */
      }
    }
    return resolvedIds;
  } catch {
    return []; // best-effort: the registry verdict already reads 'live'
  }
}
