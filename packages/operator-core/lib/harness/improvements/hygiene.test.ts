/**
 * hygiene tests — the backlog hygiene sweep
 * (learning-system-audit-improvements-2026-06-09 P-014).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { planHygieneSweep, runHygieneSweep, type HygieneSweepDeps } from './hygiene';
import type { ImprovementCandidate } from './policy';
import type { EngineerIssue } from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';

const NOW = Date.parse('2026-06-09T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string; title: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    state: 'open',
    severity: 'minor',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...p,
  };
}

describe('planHygieneSweep — dup-close', () => {
  it('keeps the highest-severity (then newest) member and closes the rest', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'a', title: 'red test harness smoke fails on boot', severity: 'minor', createdAt: daysAgo(3) }),
        cand({ id: 'b', title: 'red test harness smoke fails on boot', severity: 'major', createdAt: daysAgo(2) }),
        cand({ id: 'c', title: 'harness smoke fails on boot red test', severity: 'minor', createdAt: daysAgo(1) }),
      ],
      { nowMs: NOW },
    );
    const dupCloses = actions.filter((a) => a.kind === 'dup-close');
    expect(dupCloses.map((a) => a.id).sort()).toEqual(['a', 'c']);
    expect(dupCloses.every((a) => a.keptId === 'b')).toBe(true);
  });

  it('never dup-closes keyless near-dups whose signatures differ (the template-title false-positive, live 2026-06-09)', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'a', title: 'Test failing repeatedly: libs/papercusp/packages/orchestrator/src/invoke.test.ts' }),
        cand({ id: 'b', title: 'Test failing repeatedly: libs/papercusp/packages/orchestrator/src/state.test.ts' }),
        cand({ id: 'c', title: 'Tool plans:set-status erroring repeatedly' }),
        cand({ id: 'd', title: 'Tool plans:set-plan-status erroring repeatedly' }),
      ],
      { nowMs: NOW },
    );
    expect(actions.filter((a) => a.kind === 'dup-close')).toHaveLength(0);
  });

  it('never merges across different watchdogKeys; merges within the same key', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'k1', title: 'Tool plans:set-status erroring repeatedly', watchdogKey: 'tool-error:plans:set-status' }),
        cand({ id: 'k2', title: 'Tool plans:set-plan-status erroring repeatedly', watchdogKey: 'tool-error:plans:set-plan-status' }),
        cand({ id: 's1', title: 'service down: papercup-staging-api', watchdogKey: 'service:papercup-staging-api' }),
        cand({ id: 's2', title: 'service down papercup staging api again', watchdogKey: 'service:papercup-staging-api' }),
      ],
      { nowMs: NOW },
    );
    const dup = actions.filter((a) => a.kind === 'dup-close');
    expect(dup.every((a) => a.id !== 'k1' && a.id !== 'k2')).toBe(true);
    expect(dup).toHaveLength(1);
    expect(['s1', 's2']).toContain(dup[0].id);
  });

  it('never closes a claimed member; singleton clusters are untouched', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'a', title: 'coord send flakes under load' }),
        cand({ id: 'b', title: 'coord send flakes under load', assignee: 'improvement-runner' }),
        cand({ id: 'solo', title: 'an entirely unrelated one-off friction' }),
      ],
      { nowMs: NOW },
    );
    // b is claimed → exempt. The cluster keeps one of {a,b}; only a is closeable
    // when it is not the kept member — with equal severity, newest wins, so the
    // keeper is whichever sorts first; the claimed b must never appear.
    expect(actions.every((a) => a.id !== 'b')).toBe(true);
    expect(actions.every((a) => a.id !== 'solo')).toBe(true);
  });
});

describe('planHygieneSweep — age-out', () => {
  it('ages out an unclaimed minor item past staleDays with a quiet signature', () => {
    const actions = planHygieneSweep(
      [cand({ id: 'old', title: 'docs page typo in lexicon overview', createdAt: daysAgo(45) })],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('age-out');
    expect(actions[0].reason).toContain('45 days');
  });

  it('never ages out: young, major/critical, claimed, or recurring-signature items', () => {
    const actions = planHygieneSweep(
      [
        cand({ id: 'young', title: 'fresh minor friction', createdAt: daysAgo(5) }),
        cand({ id: 'major', title: 'old but major friction', severity: 'major', createdAt: daysAgo(60) }),
        cand({ id: 'claimed', title: 'old claimed friction', assignee: 'x', createdAt: daysAgo(60) }),
        // recurring signature: two OPEN items share it
        cand({ id: 'rec1', title: 'memory search keeps timing out', createdAt: daysAgo(40) }),
        cand({ id: 'rec2', title: 'memory search keeps timing out', createdAt: daysAgo(35) }),
      ],
      { nowMs: NOW },
    );
    // rec1/rec2 form a dup CLUSTER (one may dup-close) but neither AGES out.
    expect(actions.filter((a) => a.kind === 'age-out')).toHaveLength(0);
  });

  it('respects maxActions across both action kinds', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      cand({ id: `s${i}`, title: `stale distinct friction number ${i} entirely unique words ${i}`, createdAt: daysAgo(50) }),
    );
    expect(planHygieneSweep(items, { nowMs: NOW, maxActions: 4 })).toHaveLength(4);
  });
});

describe('runHygieneSweep — persistence + dryRun', () => {
  // Success-path stub rows — any truthy value satisfies the null-check the sweep
  // now applies (WI-7034); the loop only inspects truthiness.
  const fakeIssue = (id: string) => ({ id } as unknown as EngineerIssue);
  const fakePost = { id: 1 } as unknown as ThreadPostRow;

  const mkDeps = (items: ImprovementCandidate[], opts: { noOp?: 'merge' | 'setState' | 'both' } = {}) => {
    const closed: string[] = [];
    const merged: Record<string, unknown>[] = [];
    const commented: string[] = [];
    const deps: HygieneSweepDeps = {
      readItems: vi.fn(async () => items),
      setIssueState: vi.fn(async (id) => {
        closed.push(id);
        return opts.noOp === 'setState' || opts.noOp === 'both' ? null : fakeIssue(id);
      }),
      commentIssue: vi.fn(async (id) => {
        commented.push(id);
        return fakePost;
      }),
      mergeIssuePayload: vi.fn(async (id, patch) => {
        merged.push(patch);
        return opts.noOp === 'merge' || opts.noOp === 'both' ? null : fakeIssue(id);
      }),
    };
    return { deps, closed, merged, commented };
  };

  it('dryRun plans without writing', async () => {
    const { deps, closed, merged } = mkDeps([
      cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) }),
    ]);
    const res = await runHygieneSweep({ nowMs: NOW, dryRun: true }, deps);
    expect(res.dryRun).toBe(true);
    expect(res.planned).toHaveLength(1);
    expect(closed).toHaveLength(0);
    expect(merged).toHaveLength(0);
  });

  it('hands readItems the stale cutoff (nowMs - staleDays) so the read can select the tail as a set (WI-39455)', async () => {
    const { deps } = mkDeps([]);
    await runHygieneSweep({ nowMs: NOW, staleDays: 30, dryRun: true }, deps);
    expect(deps.readItems).toHaveBeenCalledWith({
      staleCutoffIso: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it('executes: closes with decidedReason + reject-route lifecycle', async () => {
    const { deps, closed, merged, commented } = mkDeps([
      cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) }),
    ]);
    const res = await runHygieneSweep({ nowMs: NOW }, deps);
    expect(res.agedOut).toBe(1);
    expect(res.failed).toEqual([]);
    expect(closed).toEqual(['old']);
    expect(commented).toEqual(['old']); // comment posted ONLY because the writes actually took
    expect(merged[0].decidedReason).toContain('aged out');
    const lc = merged[0].ideaLifecycle as Record<string, unknown>;
    expect(lc.state).toBe('triaged');
    expect(lc.triageDecision).toBe('reject');
  });

  // WI-7034 (live 2026-08-02): the `engineer_issues` compat view's INSTEAD OF
  // trigger silently no-ops an UPDATE against a remote-origin row (EI-7833/migration 521) —
  // mergeIssuePayload/setIssueState return null while commentIssue (a different, unguarded
  // table) still succeeds. The old code never checked the return values, so it posted a
  // "duplicate of X (hygiene sweep)" comment and counted the close as done, while the item's
  // state/payload never actually changed — it stayed open and kept re-dispatching for 11+
  // days across a 34-item duplicate chain, re-claimed by multiple agents.
  it('a no-op setIssueState is NOT counted as closed and posts NO misleading comment', async () => {
    const { deps, commented } = mkDeps(
      [cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) })],
      { noOp: 'setState' },
    );
    const res = await runHygieneSweep({ nowMs: NOW }, deps);
    expect(res.agedOut).toBe(0);
    expect(res.dupClosed).toBe(0);
    expect(res.failed).toEqual([{ id: 'old', reason: 'set-state-no-op' }]);
    expect(commented).toHaveLength(0);
  });

  it('a no-op mergeIssuePayload is NOT counted as closed and posts NO misleading comment', async () => {
    const { deps, commented } = mkDeps(
      [cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) })],
      { noOp: 'merge' },
    );
    const res = await runHygieneSweep({ nowMs: NOW }, deps);
    expect(res.agedOut).toBe(0);
    expect(res.failed).toEqual([{ id: 'old', reason: 'merge-no-op' }]);
    expect(commented).toHaveLength(0);
  });

  it('both writes no-op ⇒ reason is the combined no-op-write', async () => {
    const { deps, commented } = mkDeps(
      [cand({ id: 'old', title: 'stale minor docs nit', createdAt: daysAgo(50) })],
      { noOp: 'both' },
    );
    const res = await runHygieneSweep({ nowMs: NOW }, deps);
    expect(res.failed).toEqual([{ id: 'old', reason: 'no-op-write' }]);
    expect(commented).toHaveLength(0);
  });

  it('one no-op item does not block a later item in the same sweep from closing normally', async () => {
    const items = [
      cand({ id: 'noop', title: 'stale minor docs nit alpha', createdAt: daysAgo(50) }),
      cand({ id: 'good', title: 'stale minor docs nit beta entirely distinct wording', createdAt: daysAgo(51) }),
    ];
    const closed: string[] = [];
    const commented: string[] = [];
    const deps: HygieneSweepDeps = {
      readItems: vi.fn(async () => items),
      setIssueState: vi.fn(async (id) => {
        closed.push(id);
        return id === 'noop' ? null : fakeIssue(id);
      }),
      commentIssue: vi.fn(async (id) => {
        commented.push(id);
        return fakePost;
      }),
      mergeIssuePayload: vi.fn(async (id) => fakeIssue(id)),
    };
    const res = await runHygieneSweep({ nowMs: NOW }, deps);
    expect(res.agedOut).toBe(1);
    expect(res.failed).toEqual([{ id: 'noop', reason: 'set-state-no-op' }]);
    expect(commented).toEqual(['good']);
  });
});

// ── RECURRENCE GUARD: observation retention is retired and must stay retired ──
// P-005 of learning-loop-identity-and-consumption-2026-08-08 removed the sweep that
// hard-deleted observation rows past a 30d window, by owner directive (D-001: "why
// would we ever want to throw out observations?"; D-005: observations are a time
// series; D-029: it was ~30 min from its first permanent deletion when removed).
//
// The guard is anchored to the PROPERTY that defines the defect — SQL that DELETEs
// issue rows — not to the names the retired code happened to use. A name-anchored
// check would pass the moment someone re-added the same behaviour as
// `pruneStaleObservations`, which is exactly how a guard ends up reporting clean
// while the thing it guards is back (the form-blind-detector trap in CLAUDE.md).

/** Scan roots are overridable so falsifiability can be probed against a COPY,
 *  outside the shared tree — never by mutating these files in place. */
const guardRoot = process.env.PAPERCUSP_HYGIENE_GUARD_ROOT
  ? resolve(process.env.PAPERCUSP_HYGIENE_GUARD_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Any SQL that hard-deletes an issue/work-item row. Whitespace-tolerant so a
 *  multi-line tagged template cannot slip past on formatting alone. */
const HARD_DELETE_SQL = /DELETE\s+FROM\s+harness_shared\.(engineer_issues|work_items)\b/i;

const findHardDeletes = (source: string): string[] =>
  source.split(/\n/).flatMap((line, i) => (HARD_DELETE_SQL.test(line) ? [`${i + 1}: ${line.trim()}`] : []));

describe('observation retention stays RETIRED — no hard-delete of issue rows (D-001/D-005/D-029)', () => {
  it('CONTROL: the detector FIRES on a re-introduced hard delete (proves it can fail)', () => {
    // A deliberately-wrong sample kept permanently in the test, so this guard is
    // never a check that has only ever been observed passing.
    expect(findHardDeletes('  DELETE FROM harness_shared.engineer_issues WHERE issue_id = ANY($1)')).toHaveLength(1);
    expect(findHardDeletes('await sql`DELETE   FROM\tharness_shared.work_items`')).toHaveLength(1);
    // ...and CALIBRATION: it does not fire on deletes of other, legitimately
    // ephemeral tables (watchdog ticks), or on the lifecycle close that replaces it.
    expect(findHardDeletes('DELETE FROM harness_shared.watchdog_ticks WHERE ts < $1')).toEqual([]);
    expect(findHardDeletes("setIssueState(id, 'closed', by)")).toEqual([]);
  });

  it('issues-engineer.ts contains no hard-delete of issue rows', () => {
    const src = readFileSync(resolve(guardRoot, 'issues-engineer.ts'), 'utf8');
    expect(findHardDeletes(src)).toEqual([]);
  });

  it('no improvements-lane module hard-deletes issue rows', () => {
    const dir = resolve(guardRoot, 'harness/improvements');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.includes('.test.')) continue; // fixtures clean up their own rows
      const hits = findHardDeletes(readFileSync(resolve(dir, f), 'utf8'));
      if (hits.length) offenders.push(`${f} → ${hits.join('; ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the retired retention surface is gone from the hygiene module', async () => {
    const mod = await import('./hygiene');
    const revived = Object.keys(mod).filter((k) =>
      /observationretention|observation_hard_cap|observation_window/i.test(k),
    );
    expect(revived).toEqual([]);
  });
});

