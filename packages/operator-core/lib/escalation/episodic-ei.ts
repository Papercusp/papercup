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
 *
 * WI-6986 adds a sixth, CONVERGENT behaviour — see `collapseDuplicateOpenEis`.
 * Behaviour 5 above only MITIGATES duplicate opens (resolve closes them all);
 * nothing ever RETIRES the duplicates while the condition stays standing, so
 * they accumulate as `major`-severity triage noise (measured: 88 open
 * replication-liveness rows covering just 48 distinct conditions).
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
  /**
   * WI-37499: the literal prefix EVERY title this escalator mints starts with
   * (e.g. `'[replication-liveness] '`). When set, every population read below
   * becomes `topic-tagged ∪ title-prefixed` instead of topic-tagged alone.
   *
   * WHY THIS EXISTS. `topic` selects on a DERIVED `coord_links` tag written
   * alongside the row; the escalator's IDENTITY is the stable title. When a tag
   * write is missing the two silently disagree, and because `file`'s dedup,
   * `resolve`, `hasOpen`, the standing-cooldown gate, `collapseDuplicateOpenEis`
   * and the orphan sweep ALL read by that one tag, they go blind TOGETHER — each
   * reporting a clean pass over a population it cannot see.
   *
   * Measured 2026-08-09 on `[replication-liveness]`: 60 of 105 open rows carried
   * no topic edge, and that set held 100% of the orphan sweep's real targets (6,
   * to 34.8 days old) and 100% of the duplicate rows (12) — i.e. the blind spot
   * was perfectly anti-correlated with the work. Omit to keep an escalator's
   * behaviour byte-identical (every other instance is unchanged).
   */
  titlePrefix?: string;
}

/**
 * WI-37499: one detector population read = topic-tagged ∪ title-prefixed, deduped
 * by id (the legs overlap for every correctly-tagged row).
 *
 * The union is NOT redundant in either direction, which is why neither leg alone
 * is correct: measured 2026-08-09, 60 open rows matched the title prefix with no
 * topic edge, AND 4 tagged rows did NOT match the detector's title prefix — so a
 * prefix-only read would lose rows a tag-only read keeps.
 */
export async function unionPopulation<T extends { id: string }>(
  read: (filter: { topic?: string; titlePrefix?: string }) => Promise<T[]>,
  topic: string,
  titlePrefix: string | undefined,
): Promise<T[]> {
  const tagged = await read({ topic });
  if (!titlePrefix) return tagged;
  const byPrefix = await read({ titlePrefix });
  const seen = new Set(tagged.map((r) => r.id));
  return [...tagged, ...byPrefix.filter((r) => !seen.has(r.id))];
}

/**
 * WI-5762: the `listIssues` filter the standing-condition cooldown reads its
 * history through — bounded by TIME, not by ROW COUNT.
 *
 * `listIssues` is `ORDER BY created_at DESC LIMIT n`, so a purely row-count
 * lookback is a RECENCY WINDOW rather than a set, and it SHORTENS as filing
 * volume rises — degrading precisely during the churn bursts the cooldown
 * exists to suppress. Measured 2026-08-16 on `system:replication-liveness`: at
 * ~13 filings/day the newest 100 rows span 58.6h (comfortably past a 24h
 * cooldown), but on 08-03 at 399 filings/day the same 100 rows covered only
 * ~6h, so any repeat older than that was structurally invisible to the gate.
 * Over 14d, 417 of 899 repeat filings landed INSIDE the cooldown window and
 * were filed anyway.
 *
 * Same defect class `ListIssuesFilter.watchdogKeyed` was added for, and the
 * same remedy: filter in SQL so the read is a SET over the window instead of a
 * window over the newest N rows. `createdSince` is INCLUSIVE (`created_at >=`),
 * which matches the cooldown's own `now - lastFiledAt < cooldownMs` test at the
 * boundary. The limit rises alongside it because the window can legitimately
 * hold more than 100 rows at the observed peak — it is a backstop now, not the
 * thing deciding correctness.
 *
 * With no cooldown configured the filter is byte-identical to the pre-WI-5762
 * read, so an escalator that opted out is completely unaffected.
 */
export function cooldownLookbackFilter(
  standingCooldownMs: number | undefined,
  now: number = Date.now(),
): { limit: number; createdSince?: string } {
  if (standingCooldownMs == null) return { limit: 100 };
  return { limit: 500, createdSince: new Date(now - standingCooldownMs).toISOString() };
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

/** One open EI as the duplicate-collapse pass needs to see it. */
export interface CollapsibleOpenEi {
  id: string;
  title: string;
  /** ISO-8601. Ties are broken by `id` so the keeper is fully deterministic. */
  createdAt: string;
}

/** DI seam for `collapseDuplicateOpenEis` (same lazy-import default as the escalator). */
export interface DuplicateCollapseDeps {
  listOpenByTopic(topic: string): Promise<CollapsibleOpenEi[]>;
  /** Retire ONE duplicate row. May reject (e.g. remote-authored) — never fatal. */
  drop(id: string, note: string): Promise<void>;
}

export interface DuplicateCollapseResult {
  /** Open EIs inspected this pass. */
  checked: number;
  /** Distinct titles found holding more than one open EI. */
  duplicatedTitles: number;
  /** Ids actually retired. */
  collapsedIds: string[];
  /** Duplicates this node could not mutate (peer-authored) — expected, not a fault. */
  skippedUnmutable: number;
}

/**
 * WI-6986: collapse DUPLICATE OPEN EIs — more than one open row carrying the
 * same stable title — down to a single survivor per title.
 *
 * Why this cannot be prevented at file() time. `file()` is a read-then-create
 * (`listOpenByTopic` → `create`) with no uniqueness constraint, and the ledger
 * is FEDERATED across machines that each hold their own PG: two nodes can each
 * file for one condition before the other's row replicates in, so neither the
 * per-process `inFlight` Set nor a racing `listOpenByTopic` can see the peer's
 * not-yet-arrived row. A unique index would be actively WRONG here — it would
 * reject a legitimately-replicated peer row at ingest. The only sound fix for a
 * converging multi-writer ledger is therefore CONVERGENT, not preventive:
 * let the duplicate be created, then deterministically retire it.
 *
 * The keeper rule is `(createdAt, id)` ASCENDING — the OLDEST row survives.
 * Deterministic (every node computes the same keeper from replicated state, so
 * they cannot collectively retire all of them), and stable (a newly-arriving
 * duplicate never displaces the incumbent, so the survivor's age keeps
 * reflecting genuine FIRST detection — which is what triage sorts on).
 *
 * Each node retires only the rows it can actually mutate: a peer-authored row
 * is refused locally ("remote-authored ... its authoring peer must claim/resolve
 * it"), which is counted as `skippedUnmutable`, NOT an error. Every node running
 * the same pass over the same replicated set converges on one survivor.
 *
 * Retires as `dropped`, never `resolved`: the underlying condition may well
 * still be standing — only the redundant ROW is being discarded, and calling
 * that "resolved" would falsely assert recovery.
 *
 * Best-effort and never throws — mirrors the rest of this module, so a hiccup
 * can never wedge the scheduled sweep that calls it.
 */
export async function collapseDuplicateOpenEis(
  topic: string,
  dropNote: string,
  deps?: DuplicateCollapseDeps,
  /** WI-37499: see `EpisodicEscalatorConfig.titlePrefix` — when the detector
   *  supplies its stable-title prefix, the pass sees `topic ∪ prefix` instead of
   *  the topic tag alone. Omitted ⇒ unchanged (topic-only) behaviour. */
  opts?: { titlePrefix?: string },
): Promise<DuplicateCollapseResult> {
  const empty: DuplicateCollapseResult = {
    checked: 0,
    duplicatedTitles: 0,
    collapsedIds: [],
    skippedUnmutable: 0,
  };
  // Same VITEST-without-deps safety gate as file()/resolve(): never touch
  // production PG from a unit test that only transitively imports this.
  if (process.env.VITEST && !deps) return empty;

  let d: DuplicateCollapseDeps;
  try {
    d = deps ?? (await defaultCollapseDeps(opts?.titlePrefix));
  } catch {
    return empty;
  }

  let open: CollapsibleOpenEi[];
  try {
    open = await d.listOpenByTopic(topic);
  } catch {
    return empty;
  }

  const byTitle = new Map<string, CollapsibleOpenEi[]>();
  for (const ei of open) {
    const group = byTitle.get(ei.title);
    if (group) group.push(ei);
    else byTitle.set(ei.title, [ei]);
  }

  const result: DuplicateCollapseResult = { ...empty, checked: open.length, collapsedIds: [] };
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    result.duplicatedTitles++;
    // Oldest-wins, id as the tiebreak so every node picks the same keeper even
    // when two rows share a timestamp. An unparseable createdAt sorts LAST so a
    // malformed row is never chosen as the survivor over a well-formed one.
    const sorted = [...group].sort((a, b) => {
      const at = Date.parse(a.createdAt);
      const bt = Date.parse(b.createdAt);
      const an = Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
      const bn = Number.isFinite(bt) ? bt : Number.POSITIVE_INFINITY;
      return an === bn ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : an - bn;
    });
    for (const dupe of sorted.slice(1)) {
      try {
        await d.drop(dupe.id, dropNote);
        result.collapsedIds.push(dupe.id);
      } catch {
        // Peer-authored (or a transient write fault): its author retires it on
        // its own pass. Counted, never thrown — one refusal must not strand the
        // rest of the group.
        result.skippedUnmutable++;
      }
    }
  }
  return result;
}

/** Lazy-imported production deps for `collapseDuplicateOpenEis`. */
async function defaultCollapseDeps(titlePrefix?: string): Promise<DuplicateCollapseDeps> {
  const m = await import('../issues-engineer');
  return {
    listOpenByTopic: async (topic) => {
      // Bounded like the orphan sweep: a single pass covers the current
      // backlog; any overflow simply converges over the next few runs.
      // WI-37499: topic ∪ title-prefix, observation lane excluded on both legs —
      // this pass DROPS rows, and an agent-filed observation can carry a
      // detector's exact title (see the escalator's listOpenByTopic note).
      const rows = await unionPopulation(
        (f) => m.listIssues({ state: 'open', limit: 1000, excludeObservationLane: true, ...f }),
        topic,
        titlePrefix,
      );
      return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt }));
    },
    drop: async (id, note) => {
      await m.setIssueState(id, 'dropped', DUPLICATE_COLLAPSE_OWNER, note);
    },
  };
}

/** Resolver identity stamped on collapsed duplicates — kept distinct from a real
 *  recovery and from the orphan sweep so each closure reason stays attributable. */
export const DUPLICATE_COLLAPSE_OWNER = 'system:episodic-ei-duplicate-collapse';

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
      // WI-37499: topic-tagged ∪ title-prefixed. `excludeObservationLane` is
      // applied to BOTH legs on purpose. An agent-filed observation can share a
      // detector's stable title verbatim (measured: all 6 observation-lane
      // `[replication-liveness]` rows sat inside duplicate groups), and this list
      // feeds `resolve()` and the duplicate-collapse pass — both of which RETIRE
      // rows. Widening the read without this would let automated machinery close
      // an agent's observation as if it were the detector's own duplicate, which
      // D-005/D-035 forbid. Today it is a no-op on the topic leg (no tagged
      // observation row exists); it is stated so the property is structural
      // rather than accidental.
      listOpenByTopic: (topic) =>
        unionPopulation(
          (f) => m.listIssues({ state: 'open', limit: 100, excludeObservationLane: true, ...f }),
          topic,
          config.titlePrefix,
        ),
      create: (input) => m.createIssue(input),
      resolve: async (id, note) => {
        await m.setIssueState(id, 'resolved', recoveryOwner, note);
      },
      // WI-5762: deliberately NO `state` filter — the cooldown must see a
      // recently-RESOLVED title too, that being exactly the case open-only
      // dedup misses. `listIssues` orders created_at DESC; 100 is ample for
      // one narrow topic's episodic churn.
      listRecentByTopic: async (topic) => {
        // WI-37499: same union as the open read. Widening here makes the cooldown
        // STRICTER (it can now see a recently-filed untagged row it used to miss),
        // which is the direction the gate exists to move in.
        //
        // WI-5762: the lookback is bounded by TIME, not by ROW COUNT. `listIssues`
        // is `ORDER BY created_at DESC LIMIT n`, so a purely row-count lookback is a
        // RECENCY WINDOW rather than a set — and it shortens as filing volume rises,
        // i.e. it degrades precisely during the churn bursts this cooldown exists to
        // suppress. Measured 2026-08-16 on `system:replication-liveness`: at ~13
        // filings/day the newest 100 rows span 58.6h (comfortably past a 24h
        // cooldown), but on 08-03 at 399 filings/day the same 100 rows covered only
        // ~6h, so any repeat older than that was structurally invisible to the gate.
        // Over 14d, 417 of 899 repeat filings landed INSIDE the cooldown window and
        // were created anyway.
        //
        // This is the same defect class `ListIssuesFilter.watchdogKeyed` was added
        // for, and the same remedy: filter in SQL so the read is a SET over the
        // window instead of a window over the newest N rows. `createdSince` is
        // INCLUSIVE (`created_at >= …`). The limit is raised in step because the
        // window can legitimately hold more than 100 rows at the observed peak
        // (399/day); it is a backstop now, not the thing deciding correctness.
        const lookback = cooldownLookbackFilter(config.standingCooldownMs);
        const rows = await unionPopulation(
          (f) => m.listIssues({ ...lookback, excludeObservationLane: true, ...f }),
          topic,
          config.titlePrefix,
        );
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
