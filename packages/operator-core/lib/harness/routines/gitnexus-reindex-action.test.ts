/**
 * WI-6454 — the gitnexus re-index cadence policy.
 *
 * The two things worth pinning here are (a) the `--skip-agents-md` guard, which is the
 * difference between a maintenance job and one that corrupts every agent's prompt
 * source, and (b) the ORDER of the gates in `decideReindex` — the policy is only correct
 * if load outranks a missing index and the interval floor outranks staleness.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnalyzeArgs,
  decideReindex,
  readRegistryEntry,
  shouldSkipForHive,
  GITNEXUS_REPO_NAME,
  DEFAULT_MAX_LOAD_PER_CORE,
  DEFAULT_MIN_COMMITS_BEHIND,
  DEFAULT_MIN_INTERVAL_SEC,
  gitnexusDbPaths,
  isOrphanShadow,
  isOrphanWal,
  cleanCrashResidue,
  judgeCanary,
  GITNEXUS_HEALTH_DEFAULT,
  GITNEXUS_FAILURE_ALERT_THRESHOLD,
  decideGitnexusHealthUpdate,
  type ReindexDecisionInput,
  type GitnexusHealth,
} from './gitnexus-reindex-action';

/** A baseline that WOULD run, so each test can flip exactly one field. */
function baseInput(over: Partial<ReindexDecisionInput> = {}): ReindexDecisionInput {
  return {
    registered: true,
    commitsBehind: 50,
    loadPerCore: 0.5,
    secondsSinceIndexed: 4 * 3600,
    minCommitsBehind: DEFAULT_MIN_COMMITS_BEHIND,
    maxLoadPerCore: DEFAULT_MAX_LOAD_PER_CORE,
    minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
    ...over,
  };
}

describe('buildAnalyzeArgs', () => {
  it('ALWAYS passes --skip-agents-md (without it, analyze rewrites CLAUDE.md + AGENTS.md)', () => {
    expect(buildAnalyzeArgs('/repo', 'papercusp')).toContain('--skip-agents-md');
  });

  it('names the repo so the alias cannot collide with another checkout on the box', () => {
    const args = buildAnalyzeArgs('/repo', GITNEXUS_REPO_NAME);
    expect(args[args.indexOf('--name') + 1]).toBe(GITNEXUS_REPO_NAME);
  });

  it('analyzes the root it is given, not the process cwd', () => {
    expect(buildAnalyzeArgs('/some/root', 'x')).toContain('/some/root');
  });

  it('does not pass --force (that would defeat any staleness short-circuit analyze does)', () => {
    expect(buildAnalyzeArgs('/repo', 'x')).not.toContain('--force');
  });
});

describe('decideReindex', () => {
  it('runs when the graph is genuinely behind on an idle box', () => {
    const d = decideReindex(baseInput());
    expect(d.run).toBe(true);
    expect(d.reason).toContain('50 commits behind');
  });

  it('skips when the box is oversubscribed', () => {
    const d = decideReindex(baseInput({ loadPerCore: 2.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('lets load OUTRANK a missing index — protecting the box beats a cold build', () => {
    // Ordering guard: a missing index is the most urgent functional condition, but a
    // 4-minute indexer is the worst thing to start on a queueing box. Deferring costs
    // one hour; piling on costs the whole fleet.
    const d = decideReindex(baseInput({ registered: false, loadPerCore: 3.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('cold-builds when nothing is registered, bypassing the interval floor and staleness', () => {
    const d = decideReindex(baseInput({ registered: false, secondsSinceIndexed: 0, commitsBehind: 0 }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('cold build');
  });

  it('honours the interval floor even when many commits have landed', () => {
    // git-sync commits every few minutes, so commitsBehind climbs fast; the floor — not
    // the commit count — is what bounds steady-state cost.
    const d = decideReindex(baseInput({ secondsSinceIndexed: 10 * 60, commitsBehind: 500 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('floor');
  });

  it('skips when nothing has changed', () => {
    const d = decideReindex(baseInput({ commitsBehind: 0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('0 commit(s) behind');
  });

  it('refreshes when the indexed commit is no longer in history (rebase/prune)', () => {
    const d = decideReindex(baseInput({ commitsBehind: null }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('not in the current history');
  });

  it('treats an unknown-age index as eligible rather than blocking on the floor', () => {
    const d = decideReindex(baseInput({ secondsSinceIndexed: null }));
    expect(d.run).toBe(true);
  });

  it('honours a trigger_config override of the load ceiling', () => {
    expect(decideReindex(baseInput({ loadPerCore: 2.0, maxLoadPerCore: 4 })).run).toBe(true);
  });

  it('applies the interval floor at the boundary, not just past it', () => {
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC - 1 })).run).toBe(false);
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC })).run).toBe(true);
  });
});

describe('readRegistryEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitnexus-reg-'));

  it('reads the named repo out of the registry array', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(
      f,
      JSON.stringify([
        { name: 'other', lastCommit: 'aaa' },
        { name: 'papercusp', lastCommit: 'bbb', indexedAt: '2026-07-27T19:38:08.913Z' },
      ]),
    );
    expect(readRegistryEntry(f, 'papercusp')?.lastCommit).toBe('bbb');
  });

  it('returns null for an alias that is not registered', () => {
    const f = join(dir, 'missing.json');
    writeFileSync(f, JSON.stringify([{ name: 'other' }]));
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });

  // Every read failure must collapse to "no index" (⇒ build one), never throw a tick.
  it.each([
    ['absent file', null],
    ['unparseable json', '{not json'],
    ['not an array', '{"name":"papercusp"}'],
  ])('returns null on %s instead of throwing', (label, contents) => {
    const f = join(dir, `${String(label).replace(/\W/g, '')}.json`);
    if (contents != null) writeFileSync(f, contents);
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WI-35532 (a) — the orphan-shadow preflight. Real fs in a tmpdir, matching the
// `readRegistryEntry` tests above — no need to mock node:fs for plain file existence.
// ---------------------------------------------------------------------------
describe('isOrphanShadow', () => {
  it('is the orphan condition: shadow present, db absent', () => {
    expect(isOrphanShadow(false, true)).toBe(true);
  });

  it('is NOT orphan when the db exists (a shadow beside a real db is a build in progress)', () => {
    expect(isOrphanShadow(true, true)).toBe(false);
  });

  it('is NOT orphan when there is no shadow at all', () => {
    expect(isOrphanShadow(false, false)).toBe(false);
    expect(isOrphanShadow(true, false)).toBe(false);
  });
});

// D-016 — the MIRROR condition the shadow arm structurally cannot see. Killed AFTER the
// promote: db present, shadow absent, WAL left holding pending data. `analyze` still
// starts fine, so nothing in the WRITE path notices; every READ-ONLY open segfaults in
// the native LadybugDB binding replaying that WAL.
describe('isOrphanWal', () => {
  it('is the orphan condition: wal + db present, no shadow (a writer was killed after promoting)', () => {
    expect(isOrphanWal(true, false, true)).toBe(true);
  });

  it('is NOT orphan when a shadow is present — that WAL belongs to a live build', () => {
    // The single term that makes deleting the WAL safe. Without it this arm would
    // destroy the pending writes of a concurrent analyze.
    expect(isOrphanWal(true, true, true)).toBe(false);
  });

  it('is NOT orphan when there is no wal at all (a healthy index carries none)', () => {
    // Measured 2026-08-21: repeated successful reads leave `.gitnexus/` holding only
    // `lbug` — reads never create a WAL, which is what makes "wal present" meaningful.
    expect(isOrphanWal(true, false, false)).toBe(false);
  });

  it('is NOT orphan when there is no db — that is the SHADOW arm\'s corner, not this one', () => {
    expect(isOrphanWal(false, true, true)).toBe(false);
    expect(isOrphanWal(false, false, true)).toBe(false);
  });

  it('does not fire on the exact input the shadow arm handles (the two arms are disjoint)', () => {
    // Guards the whole point of D-016: the arms must partition the state space, never
    // both claim a cell and race each other's cleanup.
    const shadowCorner = { db: false, shadow: true, wal: false };
    expect(isOrphanShadow(shadowCorner.db, shadowCorner.shadow)).toBe(true);
    expect(isOrphanWal(shadowCorner.db, shadowCorner.shadow, shadowCorner.wal)).toBe(false);
  });
});

describe('cleanCrashResidue', () => {
  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-orphan-'));
    mkdirSync(join(root, '.gitnexus'));
    return root;
  }

  it('removes the shadow + wal checkpoint when the db is missing (the 66/66-failure wedge)', () => {
    const root = freshRoot();
    const { db, shadow, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(shadow, '');
    writeFileSync(walCheckpoint, '');
    expect(existsSync(db)).toBe(false);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-shadow');
    expect(result.removed.sort()).toEqual([shadow, walCheckpoint].sort());
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
  });

  it('removes just the shadow when there is no wal checkpoint file', () => {
    const root = freshRoot();
    const { shadow } = gitnexusDbPaths(root);
    writeFileSync(shadow, '');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-shadow');
    expect(result.removed).toEqual([shadow]);
  });

  it('removes the orphan WAL beside a real db — the read-path segfault (D-016)', () => {
    // THE REGRESSION. Before this arm existed, cleanCrashResidue's predecessor no-opped
    // on exactly this tree, the next tick re-ran analyze, re-timed-out, and re-orphaned
    // the WAL — while every agent's gitnexus call died on WAL replay.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');
    writeFileSync(wal, 'pending-writes-from-a-killed-analyze');
    expect(existsSync(shadow)).toBe(false);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-wal');
    expect(result.removed).toEqual([wal]);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(db)).toBe(true); // the database itself is never touched
  });

  it('touches NOTHING when the db exists — a shadow beside a real db is an in-progress build', () => {
    const root = freshRoot();
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'not-really-a-db-but-present');
    writeFileSync(shadow, '');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.removed).toEqual([]);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(shadow)).toBe(true); // untouched
  });

  it('leaves a live build\'s WAL alone when a shadow is present beside it', () => {
    // The concurrency rail: db + shadow + wal is an analyze mid-flight. Deleting that
    // WAL would corrupt a healthy build to "fix" a tree that was never broken.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');
    writeFileSync(shadow, 'building');
    writeFileSync(wal, 'live-pending-writes');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(existsSync(wal)).toBe(true);
    expect(existsSync(shadow)).toBe(true);
  });

  it('touches NOTHING on a healthy index — db present, no shadow, no wal', () => {
    const root = freshRoot();
    const { db } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(existsSync(db)).toBe(true);
  });

  it('touches NOTHING when there is no index at all (nothing to clean)', () => {
    const root = freshRoot();
    const result = cleanCrashResidue(root);
    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P-004 — the semantic canary. Pure policy, no graph and no subprocess.
// ---------------------------------------------------------------------------
describe('judgeCanary', () => {
  // Real measured values from the live graph, 2026-08-21.
  const HEALTHY: Parameters<typeof judgeCanary>[0] = {
    fileCount: 19479,
    symbolCount: 66982,
    callEdgeCount: 99020,
    defEdgeCount: 132452,
    roundTripOk: true,
    embeddings: 0,
  };

  it('passes a healthy graph', () => {
    const v = judgeCanary(HEALTHY);
    expect(v.healthy).toBe(true);
    expect(v.summary).toContain('canary OK');
  });

  it('does NOT fail on 0 embeddings — a known, accepted condition (WI-35557)', () => {
    // A canary that fires on an accepted state gets muted, and the mute takes the real
    // signal with it. Vector status is reported, never fatal.
    const v = judgeCanary({ ...HEALTHY, embeddings: 0 });
    expect(v.healthy).toBe(true);
    expect(v.probes.find((p) => p.name === 'vector-search')!.detail).toContain('EXPECTED');
  });

  it('CALIBRATION: fails when the graph is unreadable, and says so as UNREADABLE not EMPTY', () => {
    // THE OUTAGE, in one assertion. A segfaulting read returns no rows, which is
    // trivially mistaken for "the graph is empty". Those need different responses:
    // empty means re-index, unreadable means recover the crash residue first.
    const v = judgeCanary({ ...HEALTHY, fileCount: null });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('graph-answers');
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toContain('unreadable');
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toContain('NOT merely empty');
  });

  it('fails a genuinely empty graph too, distinctly from an unreadable one', () => {
    const v = judgeCanary({ ...HEALTHY, fileCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toBe('0 files');
  });

  it('fails when call edges are missing — "who calls this" is the capability agents come for', () => {
    const v = judgeCanary({ ...HEALTHY, callEdgeCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('call-edges');
  });

  it('fails when a symbol PRESENT in the graph will not resolve through the lookup path', () => {
    // Data intact, read path broken — invisible to every count-based check.
    const v = judgeCanary({ ...HEALTHY, roundTripOk: false });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'symbol-round-trip')!.detail).toContain('read path is broken');
  });

  it('fails rather than passes when the round trip could not be attempted at all', () => {
    // Unknown must not read as OK — the same in-band rule as the freshness metadata.
    const v = judgeCanary({ ...HEALTHY, roundTripOk: null });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'symbol-round-trip')!.detail).toContain('not attempted');
  });

  it('fails when definition edges are missing — "where is this defined" is the other core capability', () => {
    const v = judgeCanary({ ...HEALTHY, defEdgeCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('definition-edges');
  });

  it('reports every failing probe, not just the first', () => {
    const v = judgeCanary({ fileCount: null, symbolCount: null, callEdgeCount: null, defEdgeCount: null, roundTripOk: null, embeddings: null });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('5/6');
  });
});

describe('canary edge queries target the REAL graph schema', () => {
  // A REGRESSION GUARD FOR A TRAP I FELL INTO. The obvious Cypher for call edges,
  // `MATCH ()-[r:CALLS]->()`, does not return zero on this graph — it throws
  // "Binder exception: Table CALLS does not exist", which the runner maps to null and
  // the judge reads as UNREADABLE. That would have failed the canary on every healthy
  // index forever: a permanent false alarm, in the exact shape the canary's own doc
  // comment warns against. It survived unit tests because a pure judge cannot see a
  // wrong query, and was caught only by running it against the live graph.
  //
  // This graph has ONE relationship table, `CodeRelation`; the kind is a PROPERTY
  // (r.type ∈ CALLS | DEFINES | IMPORTS | ...). Asserting on the source text is
  // deliberate: the alternative is a live-graph integration test, which cannot run in
  // CI, so the schema assumption is pinned where it is cheap to check.
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');

  // Comments are stripped before matching. The doc comment above runCanary quotes the
  // bad query verbatim as a counter-example, and without this the guard fails on the
  // very explanation of what it guards — which is a false positive, and false positives
  // are what get a guard deleted.
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('queries CodeRelation with a type predicate, never a bare :CALLS/:DEFINES table', () => {
    expect(CODE).toContain("r.type = 'CALLS'");
    expect(CODE).toContain("r.type = 'DEFINES'");
    expect(CODE).not.toMatch(/MATCH\s*\(\)-\[r:CALLS\]/);
    expect(CODE).not.toMatch(/MATCH\s*\(\)-\[r:DEFINES\]/);
  });

  it('CALIBRATION: comment-stripping did not eat the executable source too', () => {
    // Without this, a stripper bug that returned '' would make every not-toMatch above
    // pass vacuously — the guard would be dead and look green.
    expect(CODE.length).toBeGreaterThan(1000);
    expect(CODE).toContain('CodeRelation');
    expect(CODE).toContain('export async function runCanary');
  });
});

// ---------------------------------------------------------------------------
// WI-35532 (b) — the failure-alarm state machine. Pure, DB-free.
// ---------------------------------------------------------------------------
describe('decideGitnexusHealthUpdate', () => {
  const NOW = 1_700_000_000_000;

  it('resets the streak and stamps lastSuccessAt on a success from a clean slate', () => {
    const u = decideGitnexusHealthUpdate(GITNEXUS_HEALTH_DEFAULT, true, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.next).toEqual({ consecutiveFailures: 0, alerted: false, lastFailureAt: null, lastSuccessAt: NOW });
    expect(u.shouldAlert).toBe(false);
    expect(u.shouldResolve).toBe(false); // was never alerted — nothing to resolve
  });

  it('increments on a failure but does NOT alert below the threshold', () => {
    const prev: GitnexusHealth = { consecutiveFailures: 1, alerted: false, lastFailureAt: NOW - 3600_000, lastSuccessAt: null };
    const u = decideGitnexusHealthUpdate(prev, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.next.consecutiveFailures).toBe(2);
    expect(u.shouldAlert).toBe(false);
    expect(u.next.alerted).toBe(false);
  });

  it('alerts on EXACTLY the tick that crosses the threshold, not before and not again after', () => {
    // One failure short of the threshold — the NEXT failure is the one that crosses it.
    const oneShortOfThreshold: GitnexusHealth = {
      consecutiveFailures: GITNEXUS_FAILURE_ALERT_THRESHOLD - 1,
      alerted: false,
      lastFailureAt: NOW - 3600_000,
      lastSuccessAt: null,
    };
    const atCrossing = decideGitnexusHealthUpdate(oneShortOfThreshold, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(atCrossing.next.consecutiveFailures).toBe(GITNEXUS_FAILURE_ALERT_THRESHOLD);
    expect(atCrossing.shouldAlert).toBe(true);
    expect(atCrossing.next.alerted).toBe(true);

    // One more failure past the threshold must NOT re-alert (alerted already true).
    const alreadyAlerted = decideGitnexusHealthUpdate(atCrossing.next, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW + 1000);
    expect(alreadyAlerted.shouldAlert).toBe(false);
    expect(alreadyAlerted.next.consecutiveFailures).toBe(GITNEXUS_FAILURE_ALERT_THRESHOLD + 1);
    expect(alreadyAlerted.next.alerted).toBe(true);
  });

  it('resolves (once) on the success that follows an alerted streak, and clears the streak', () => {
    const alerted: GitnexusHealth = { consecutiveFailures: 5, alerted: true, lastFailureAt: NOW - 1000, lastSuccessAt: NOW - 999_999 };
    const u = decideGitnexusHealthUpdate(alerted, true, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.shouldResolve).toBe(true);
    expect(u.next).toEqual({ consecutiveFailures: 0, alerted: false, lastFailureAt: alerted.lastFailureAt, lastSuccessAt: NOW });
  });

  it('never fires shouldAlert AND shouldResolve on the same tick', () => {
    for (const success of [true, false]) {
      for (const alerted of [true, false]) {
        const prev: GitnexusHealth = { consecutiveFailures: 3, alerted, lastFailureAt: null, lastSuccessAt: null };
        const u = decideGitnexusHealthUpdate(prev, success, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
        expect(u.shouldAlert && u.shouldResolve).toBe(false);
      }
    }
  });
});

describe('shouldSkipForHive', () => {
  it('skips a per-hive harness — the graph indexes the operator-home repo', () => {
    const g = shouldSkipForHive('some-hive', 'papercusp');
    expect(g.skip).toBe(true);
  });

  it('runs for the operator-home harness', () => {
    expect(shouldSkipForHive('papercusp', 'papercusp').skip).toBe(false);
  });

  it('treats a blank slug (manual/legacy fire) as operator-home', () => {
    expect(shouldSkipForHive(undefined, 'papercusp').skip).toBe(false);
    expect(shouldSkipForHive('', 'papercusp').skip).toBe(false);
  });
});
