/**
 * replication-stall-orphan-sweep — closes the "orphaned forever" hole in the
 * replication-stall EI escalator (replication-stall-ei.ts).
 *
 * Root cause (found triaging the papercusp open-bug backlog, 2026-07-20): a
 * filed replication-stall EI (P-004 / WI-1840, WI-183 class) is auto-resolved
 * ONLY when a live process later re-observes the SAME (workspace, harness,
 * log) recover (`sampleReplicationLiveness`'s onRecovery leg) or explicitly
 * drops that log's tracking state (`dropReplicationLogState` /
 * `dropReplicationLiveness` → `reportDropRecoveries`). Both paths require a
 * process to be ALIVE and running under the target harness's identity.
 *
 * When the target harness is renamed or deleted, no future process will EVER
 * again report that (workspace, harness) pair, so its open stall EIs can
 * never receive a recovery sample or a drop call — they sit open FOREVER as
 * `major`-severity noise. Confirmed live: the papercup→papercusp rename alone
 * orphaned 30 open EIs (title `harness=papercup`) out of 133 open
 * `[replication-liveness]` bugs in the papercusp backlog — a permanent,
 * unresolvable class that will recur on every future harness rename/delete
 * unless swept.
 *
 * This sweep is the durable fix: periodically (see the `replicationStallOrphanSweep`
 * DBOS scheduled workflow in dbos/periodic-workflows.ts) list every OPEN
 * replication-stall EI, parse its target `workspace=… harness=…` (the same
 * fields `buildReplicationStallBody` always stamps into the EI body), and
 * auto-resolve any whose target harness no longer exists in that workspace's
 * harness registry. A harness that doesn't exist can, by construction, never
 * again produce a recovery sample — resolving is unconditionally safe and
 * loses no signal (a harness re-created under the same slug that re-stalls
 * files a fresh EI normally).
 *
 * Deliberately conservative: a harness that still EXISTS (even if currently
 * idle/dormant) is left untouched here, even though many of the papercusp
 * backlog's other open replication-stall EIs target long-abandoned one-off
 * test/dev harnesses that still have a registry row. Auto-closing those would
 * risk silently hiding a genuinely still-open defect on a harness that could
 * boot again; that needs a human/agent to positively verify current liveness
 * per item (see the per-episode manual resolutions this sweep's discovery
 * prompted), not a blanket time-based sweep.
 */

const TARGET_RE = /workspace=(\S+)\s+harness=(\S+)/;

/** Parse the `workspace=… harness=…` target stamped by buildReplicationStallBody. */
export function parseStallEiTarget(
  body: string,
): { workspaceId: string; harnessSlug: string } | null {
  const m = TARGET_RE.exec(body);
  if (!m) return null;
  return { workspaceId: m[1], harnessSlug: m[2] };
}

/** Resolver identity stamped on orphan-swept EIs — distinct from the normal
 *  recovery-sample RECOVERY_OWNER so the two closure reasons stay attributable. */
export const ORPHAN_SWEEP_OWNER = 'system:replication-liveness-orphan-sweep';

/** Max open EIs inspected per sweep pass (listIssues has no offset/cursor —
 *  a single pass covers the whole current backlog; a future overflow just
 *  converges over the next few daily runs instead of in one). */
const SWEEP_LIMIT = 1000;

export interface OrphanSweepDeps {
  listOpenReplicationStallEis(): Promise<Array<{ id: string; body: string }>>;
  harnessExists(workspaceId: string, harnessSlug: string): Promise<boolean>;
  resolve(id: string, note: string): Promise<void>;
}

export interface OrphanSweepResult {
  /** Open replication-stall EIs inspected this pass. */
  checked: number;
  /** Distinct "workspace::harness" targets confirmed no longer to exist. */
  orphanedTargets: string[];
  /** EI ids actually auto-resolved. */
  resolvedIds: string[];
  /** Per-item resolve failures (best-effort — one failure never strands the rest). */
  errors: number;
}

async function defaultDeps(): Promise<OrphanSweepDeps> {
  const [{ listIssues, setIssueState }, { harnessExistsInWorkspace }, { REPLICATION_LIVENESS_TOPIC, RECOVERY_OWNER }] =
    await Promise.all([
      import('../../issues-engineer'),
      import('../../device-harnesses'),
      import('./replication-stall-ei'),
    ]);
  return {
    listOpenReplicationStallEis: async () => {
      const issues = await listIssues({
        state: 'open',
        topic: REPLICATION_LIVENESS_TOPIC,
        limit: SWEEP_LIMIT,
      });
      return issues.map((i) => ({ id: i.id, body: i.body }));
    },
    harnessExists: harnessExistsInWorkspace,
    resolve: async (id, note) => {
      // RECOVERY_OWNER (not ORPHAN_SWEEP_OWNER) would also be reasonable, but a
      // distinct identity here makes "closed because the target no longer
      // exists" greppable/attributable separately from a real recovery sample.
      void RECOVERY_OWNER; // (kept for readability of the destructure; unused directly)
      await setIssueState(id, 'resolved', ORPHAN_SWEEP_OWNER, note);
    },
  };
}

/**
 * One sweep pass: resolve every open replication-stall EI whose target
 * harness no longer exists. Never throws — best-effort, mirrors the rest of
 * the episodic-ei machinery (a sweep hiccup must never wedge its scheduled
 * caller). Same VITEST-without-deps safety gate as episodic-ei.ts: a unit
 * test exercising other logic that transitively imports this module must
 * never touch production PG.
 */
export async function runReplicationStallOrphanSweepOnce(
  deps?: OrphanSweepDeps,
): Promise<OrphanSweepResult> {
  if (process.env.VITEST && !deps) {
    return { checked: 0, orphanedTargets: [], resolvedIds: [], errors: 0 };
  }
  let d: OrphanSweepDeps;
  try {
    d = deps ?? (await defaultDeps());
  } catch {
    return { checked: 0, orphanedTargets: [], resolvedIds: [], errors: 0 };
  }

  let open: Array<{ id: string; body: string }>;
  try {
    open = await d.listOpenReplicationStallEis();
  } catch {
    return { checked: 0, orphanedTargets: [], resolvedIds: [], errors: 0 };
  }

  const existsCache = new Map<string, boolean>();
  const orphanedTargets = new Set<string>();
  const resolvedIds: string[] = [];
  let errors = 0;

  for (const issue of open) {
    const target = parseStallEiTarget(issue.body);
    if (!target) continue; // malformed/foreign body — never touched

    const cacheKey = `${target.workspaceId}::${target.harnessSlug}`;
    let exists = existsCache.get(cacheKey);
    if (exists === undefined) {
      try {
        exists = await d.harnessExists(target.workspaceId, target.harnessSlug);
      } catch {
        exists = true; // fail CLOSED on an uncertain existence check — never resolve
      }
      existsCache.set(cacheKey, exists);
    }
    if (exists) continue;

    orphanedTargets.add(cacheKey);
    try {
      await d.resolve(
        issue.id,
        `auto-resolved (orphan sweep): target harness '${target.harnessSlug}' no longer exists in ` +
          `workspace '${target.workspaceId}' — this replication-liveness stall can never receive a ` +
          `recovery sample (the harness was renamed, deleted, or never re-created), so it would ` +
          `otherwise stay open forever as noise. If a harness with this slug is re-created and ` +
          `re-stalls, a fresh alert files normally.`,
      );
      resolvedIds.push(issue.id);
    } catch {
      errors += 1;
    }
  }

  return { checked: open.length, orphanedTargets: [...orphanedTargets], resolvedIds, errors };
}
