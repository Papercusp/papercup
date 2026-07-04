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
 * The EI surface also escalates the WI-2009 outbox-drain watchdog (kind
 * 'drain_stalled' — same durable-EI + dedup mechanism, same triage topic; the
 * "logKeyHex" slot carries the own-log key as the harness's stable identifier).
 */
export type StallEiEpisode = Omit<ReplicationStallEpisode, 'kind'> & {
  kind: ReplicationStallEpisode['kind'] | 'drain_stalled';
};

/** Stable, dedup-able title for one (harness, log, kind). */
export function replicationStallEiTitle(episode: {
  harnessSlug: string;
  logKeyHex: string;
  kind: 'no_replicator' | 'frozen' | 'connected_never_replicated' | 'drain_stalled';
}): string {
  return (
    `[replication-liveness] ${episode.kind}: harness=${episode.harnessSlug} ` +
    `log=${episode.logKeyHex.slice(0, 12)}… (WI-183 class)`
  );
}

/** DI seam so the dedup+file logic unit-tests without PG. */
export interface ReplicationStallEiDeps {
  listOpenByTopic(topic: string): Promise<Array<{ title: string }>>;
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
}

async function defaultDeps(): Promise<ReplicationStallEiDeps> {
  const m = await import('../../issues-engineer');
  return {
    listOpenByTopic: (topic) =>
      m.listIssues({ state: 'open', topic, limit: 100 }),
    create: (input) => m.createIssue(input),
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
