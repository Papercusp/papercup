/**
 * episodic-ei — the shared machinery behind an episodic durable-EI escalator.
 *
 * A "detector" (replication-liveness, own-log-fork, …) observes a process-local
 * condition that evaporates on restart and is visible only to whoever polls a
 * status surface. To make an episode survive — so a connected-but-dead peer or a
 * forked own-log shows up in the fleet's triage queue even when nobody is
 * watching — it files a durable `engineer_issues` row (an EI). Every such
 * escalator wants the SAME five behaviours:
 *
 *   1. a stable, dedup-able title so re-arming after a restart doesn't re-file;
 *   2. a per-process in-flight Set as a second dedup layer under racing passes;
 *   3. a VITEST-without-`deps` safety gate so a unit test exercising the DETECTION
 *      logic against a real (test-scoped) handle never files into production PG;
 *   4. a lazy-imported default `deps` (issues-engineer) so importing the detector
 *      doesn't pull PG in, and unit tests inject their own seam;
 *   5. dedup-against-open on file, and resolve-ALL-matching (not `.find`) on
 *      recovery — the federated multi-machine ledger legitimately holds duplicate
 *      open EIs for one condition (EI-6772 class), and a `.find` strands them.
 *
 * This factory captures all five once; `replication-stall-ei.ts` and
 * `own-log-fork-ei.ts` are thin wrappers over it (EI-9030a). It is domain-free —
 * a detector supplies only its topic, title/body/note builders, severity, and
 * provenance strings.
 */

import type { IssueSeverity } from '../issues-engineer';

/**
 * DI seam so an escalator's dedup+file logic unit-tests without PG. `Sev` pins
 * the severity literal a given escalator files at (a stall is 'major', a fork is
 * 'critical'), keeping the wrapper-exported `*EiDeps` types byte-identical.
 */
export interface EpisodicEiDeps<Sev extends IssueSeverity = IssueSeverity> {
  listOpenByTopic(topic: string): Promise<Array<{ id: string; title: string }>>;
  create(input: {
    title: string;
    body: string;
    severity: Sev;
    source: 'engineer';
    kind: 'bug';
    topics: string[];
    createdBy: string;
    foundDuring: string;
  }): Promise<{ id: string }>;
  /** Resolve a previously-filed EI once its condition has recovered. */
  resolve(id: string, note: string): Promise<void>;
  /**
   * WI-5762 (standing-condition delta gate): every EI for this topic — ANY
   * state, not just open — most-recently-created first. Used only when a
   * config sets `standingCooldownMs`; omit/leave undefined to opt an
   * escalator out (byte-identical to pre-WI-5762 behavior). Optional so
   * every existing hand-rolled `deps` object (tests, other escalators)
   * keeps compiling without change.
   */
  listRecentByTopic?(topic: string): Promise<Array<{ title: string; createdAt: string }>>;
}

export interface EpisodicEscalatorConfig<E, R, Sev extends IssueSeverity> {
  /** Primary triage topic; also the dedup-listing key (`listOpenByTopic`). */
  topic: string;
  /** Stable dedup title from either a to-file episode or a recovery descriptor. */
  stableTitle: (x: E | R) => string;
  /** The EI body for a to-file episode. */
  buildBody: (episode: E) => string;
  /** The resolution note for a recovered episode. */
  resolveNote: (recovery: R) => string;
  severity: Sev;
  /** Provenance stamped on the filed EI (`created_by`). */
  createdBy: string;
  /** Provenance stamped on the filed EI (`found_during`). */
  foundDuring: string;
  /** Resolver identity stamped on auto-resolved EIs. Defaults to `createdBy`
   *  (both current callers set them equal). */
  recoveryOwner?: string;
  /** Extra topics tagged alongside `topic` on the filed EI. Default `['federation']`. */
  extraTopics?: string[];
  /**
   * WI-5762 (standing-condition delta gate): suppress re-filing a title that
   * was ALREADY filed (in any state — open OR resolved/closed) within this
   * many milliseconds. `listOpenByTopic`-only dedup catches a title only
   * while an EI for it still EXISTS open; once a separate subsystem retires
   * it (auto-recovery close, a human resolving it, hygiene dup-close) the
   * very next re-detection of the SAME standing condition finds no open
   * match and mints a fresh duplicate — measured at 57 duplicate EIs for one
   * standing replication-stall over a 7d window. This cooldown is
   * independent of the retired EI's state, closing that hole. Omit (default
   * undefined) to keep the pre-WI-5762 open-only-dedup behavior unchanged —
   * every OTHER escalator instance stays byte-identical.
   */
  standingCooldownMs?: number;
}

export interface EpisodicEscalator<E, R, Sev extends IssueSeverity = IssueSeverity> {
  /** The primary triage topic (re-exported by wrappers as their `*_TOPIC`). */
  readonly topic: string;
  /** The resolver identity (re-exported by wrappers as their `RECOVERY_OWNER`). */
  readonly recoveryOwner: string;
  /**
   * File a durable EI for an episode, deduplicating against open EIs with the
   * same stable title. Returns the EI id when filed, null when deduped or on
   * failure (best-effort — the caller never awaits this on its hot path).
   */
  file(episode: E, deps?: EpisodicEiDeps<Sev>): Promise<string | null>;
  /**
   * Auto-resolve EVERY open EI matching the episode's stable title. No-ops
   * (returns `[]`) when none match — the normal case. Best-effort: a resolve
   * failure never throws, and each EI is resolved independently so one failure
   * never strands its siblings.
   */
  resolve(recovery: R, deps?: EpisodicEiDeps<Sev>): Promise<string[]>;
  /**
   * WI-5332: best-effort check for whether an EI is ALREADY open for this
   * stable title — the one signal a process-lifetime-scoped detector can use
   * to see PAST its own restart (an open EI survives in PG; nothing else
   * here does). Same VITEST safety gate as file()/resolve() (returns false
   * rather than touching production PG unless a test passes `deps`); any
   * other failure also degrades to false — never a reason to block the
   * caller's own in-process fallback behavior.
   */
  hasOpen(x: E | R, deps?: EpisodicEiDeps<Sev>): Promise<boolean>;
  /** Test seam: clear the per-process in-flight guard. */
  _resetForTests(): void;
}

/**
 * Build an episodic durable-EI escalator. Each instance owns its own
 * per-process in-flight Set (cleared by `_resetForTests`).
 */
export function createEpisodicEscalator<E, R, Sev extends IssueSeverity>(
  config: EpisodicEscalatorConfig<E, R, Sev>,
): EpisodicEscalator<E, R, Sev> {
  const recoveryOwner = config.recoveryOwner ?? config.createdBy;
  const topics = [config.topic, ...(config.extraTopics ?? ['federation'])];

  async function defaultDeps(): Promise<EpisodicEiDeps<Sev>> {
    const m = await import('../issues-engineer');
    return {
      listOpenByTopic: (topic) => m.listIssues({ state: 'open', topic, limit: 100 }),
      create: (input) => m.createIssue(input),
      resolve: async (id, note) => {
        await m.setIssueState(id, 'resolved', recoveryOwner, note);
      },
      // WI-5762: deliberately NO `state` filter — the cooldown must see a
      // recently-RESOLVED title too, that being exactly the case open-only
      // dedup misses. `listIssues` orders created_at DESC; 100 is ample for
      // one narrow topic's episodic churn.
      listRecentByTopic: async (topic) => {
        const rows = await m.listIssues({ topic, limit: 100 });
        return rows.map((r) => ({ title: r.title, createdAt: r.createdAt }));
      },
    };
  }

  /** Per-process in-flight/filed guard (second dedup layer under racing passes). */
  const inFlight = new Set<string>();

  return {
    topic: config.topic,
    recoveryOwner,

    _resetForTests(): void {
      inFlight.clear();
    },

    async file(episode, deps): Promise<string | null> {
      const title = config.stableTitle(episode);
      if (inFlight.has(title)) return null;
      // VITEST safety gate (EI-6987): the detector fires this as an unawaited
      // side effect — including from a unit test that boots a real test-scoped
      // handle to exercise DETECTION, not filing. Without a deps override that
      // would hit defaultDeps()'s REAL createIssue() against production PG. A
      // test that DOES want real filing passes its own `deps` to opt back in.
      if (process.env.VITEST && !deps) return null;
      inFlight.add(title);
      try {
        const d = deps ?? (await defaultDeps());
        const open = await d.listOpenByTopic(config.topic);
        if (open.some((i) => i.title === title)) return null; // already escalated
        // WI-5762 standing-condition delta gate: a title filed (in ANY state)
        // within the cooldown window is still "standing" even though the
        // open-check above just found no match — suppress the duplicate
        // rather than re-filing. Best-effort: a lookup failure here must
        // never block a genuinely-new episode from filing, so it falls
        // through to create() on any error (fail OPEN, same policy as the
        // watchdog's sibling delta gate).
        if (config.standingCooldownMs != null && d.listRecentByTopic) {
          try {
            const recent = await d.listRecentByTopic(config.topic);
            const lastFiledAt = recent
              .filter((i) => i.title === title)
              .map((i) => Date.parse(i.createdAt))
              .filter((ms) => Number.isFinite(ms))
              .reduce((max, ms) => Math.max(max, ms), -Infinity);
            if (Number.isFinite(lastFiledAt) && Date.now() - lastFiledAt < config.standingCooldownMs) {
              return null; // standing condition recently reported (open or since-closed) — suppress
            }
          } catch {
            /* fail open — see comment above */
          }
        }
        const created = await d.create({
          title,
          body: config.buildBody(episode),
          severity: config.severity,
          source: 'engineer',
          kind: 'bug',
          topics,
          createdBy: config.createdBy,
          foundDuring: config.foundDuring,
        });
        return created.id;
      } catch {
        return null; // best-effort: the registry verdict still surfaces the condition
      } finally {
        // Release the guard so a transient PG failure can retry on the NEXT
        // episode (episodes are edge-triggered, so this is at most once per re-arm).
        inFlight.delete(title);
      }
    },

    async resolve(recovery, deps): Promise<string[]> {
      const title = config.stableTitle(recovery);
      // Same VITEST safety gate as file(): a detection unit test with a real
      // reporter (no deps) must never touch production PG.
      if (process.env.VITEST && !deps) return [];
      try {
        const d = deps ?? (await defaultDeps());
        const open = await d.listOpenByTopic(config.topic);
        const matches = open.filter((i) => i.title === title);
        if (matches.length === 0) return [];
        const resolvedIds: string[] = [];
        for (const match of matches) {
          try {
            await d.resolve(match.id, config.resolveNote(recovery));
            resolvedIds.push(match.id);
          } catch {
            /* per-EI best-effort: one resolve failure must not strand its siblings */
          }
        }
        return resolvedIds;
      } catch {
        return []; // best-effort: the registry verdict already reads recovered
      }
    },

    async hasOpen(x, deps): Promise<boolean> {
      const title = config.stableTitle(x);
      // Same VITEST safety gate as file()/resolve(): a detection-only unit
      // test with no real reporter/deps must never touch production PG.
      if (process.env.VITEST && !deps) return false;
      try {
        const d = deps ?? (await defaultDeps());
        const open = await d.listOpenByTopic(config.topic);
        return open.some((i) => i.title === title);
      } catch {
        return false; // best-effort: the caller's own fallback path still applies
      }
    },
  };
}
