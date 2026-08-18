/**
 * P-011 (agent-state-plane-verification-2026-07-27) — ASSERT EVERY REGISTERED CELL'S
 * FALSIFIER IS REAL.
 *
 * ── WHY THIS FILE EXISTS, GIVEN cell-registrations.test.ts ALREADY PASSES ─────
 *
 * That suite is 311 lines and every one of its falsifier assertions compares a
 * DECLARATION TO ANOTHER DECLARATION: `f.field !== spec.headline`,
 * `kills.toContain('normal steady state')`, `measurement).toContain('coord_links')`.
 * Not one of them ever calls a resolver. So the entire existing guard is satisfied
 * by a spec whose `falsifier.field` names a path THAT NO RESOLVER PRODUCES — and
 * `validateCellSpec` cannot close the gap either, because it is deliberately
 * domain-free (cell-registry.ts:29) and only normalises strings.
 *
 * That failure mode is silent and confident, which is what makes it worth a file:
 * `valueAtPath` returns `undefined` for a MISSING key and for a key that is
 * PRESENT-BUT-NULL alike (predicate-watch.ts:144). A typo'd falsifier path
 * therefore reads exactly like the most ordinary case there is — a nullable cell
 * with nothing to report — and `readCell` would answer `insufficient-data`
 * forever while every declaration test stayed green.
 *
 * ⚠ THE DISTINCTION THIS FILE IS BUILT ON, and it is the whole reason the checks
 * below use `pathExists` rather than `valueAtPath`: MISSING ≠ NULL. A nullable
 * cell reading `null` is HEALTHY (`goalRef: null` for an agent holding nothing is
 * the documented ordinary case — goal.ts:64-74). A cell whose declared key is
 * absent from the object graph is BROKEN. Asserting "not undefined" would
 * conflate them and this suite would fail on healthy systems while still missing
 * the defect; asserting own-key presence separates them exactly.
 *
 * ── WHAT "REAL" IS TAKEN TO MEAN HERE ────────────────────────────────────────
 *
 * The payload a cell's paths are walked against is NOT its resolver function's
 * return value — it is the RESULT OF THE POLL TOOL named in `changeSignal.tool`,
 * because that is what `readCell` dispatches (cell-read.ts:293). The two differ,
 * and confusing them produces a confident false alarm: `resolveOwnerGoal()`
 * returns `{ ref, source, agreement, ... }` with no `goalRef` and no `goalUnknown`
 * anywhere, so probing the raw resolver reports all four of `agent.goal`'s
 * declared paths as missing. They are not missing; `coord:goal` hoists them
 * (goal.ts:75/83) precisely so the goal-less case reads as null instead of drift.
 * Every check below therefore drives the TOOL's payload assembly.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { CellSpec } from './cell-registry';
import { BUILTIN_CELLS } from './cell-registrations';
import { gitPipelinePosition } from './git-pipeline-position';
import hostMemoryPressureTool from './agent-tools/state/host-memory';
import coverageTool from './agent-tools/testing/coverage';

/**
 * EI-19316737896654304 — this file takes the no-real-PG rail's DOCUMENTED opt-out
 * (EI-19311807188719573, `libs/test-config/src/setup-no-real-pg.ts`), which reads:
 * "A unit test that genuinely needs a live pool can delete the var in its own
 * beforeAll/test body — that runs AFTER this module-level set and so still wins."
 *
 * ⚠ THE OPT-OUT, NOT THE AUTHOR'S PREFERRED RENAME, AND THE REASON MATTERS. That note
 * prefers renaming such a file to `*.integration.test.ts`, and for almost every other
 * file caught by the rail that IS the right move. It is the wrong one here: the
 * integration layer builds against a THROWAWAY TESTCONTAINER, and this suite's entire
 * premise (see the file header, and the "Mutating the returned payload would prove
 * NOTHING" note below) is that a cell's declared paths are walked against a payload
 * this box's LIVE resolver actually produced. An empty testcontainer would answer with
 * a differently-shaped payload assembled from no gate/deploy state, so the rename would
 * not preserve this suite — it would silently convert a reality check into a fixture
 * check, which is precisely the class of guard this file was written to replace.
 *
 * This is NOT the accident the rail exists to catch. The rail was built for a leg that
 * escaped `vi.mock` and read a live WI row, staying green until that row was closed —
 * i.e. a test asserting live DATA by accident. Everything here asserts payload SHAPE
 * (own-key presence) and pivots off values it reads from the same live run rather than
 * hardcoding them, so no live row's contents can make it pass or fail.
 *
 * Restored in afterAll so the exemption cannot leak to another file sharing this worker.
 */
let forbidRealPgBefore: string | undefined;
beforeAll(() => {
  forbidRealPgBefore = process.env.PAPERCUSP_FORBID_REAL_PG;
  delete process.env.PAPERCUSP_FORBID_REAL_PG;
});
afterAll(() => {
  if (forbidRealPgBefore === undefined) delete process.env.PAPERCUSP_FORBID_REAL_PG;
  else process.env.PAPERCUSP_FORBID_REAL_PG = forbidRealPgBefore;
});

/**
 * Own-key path walk. Returns whether every SEGMENT is present in the object graph,
 * independently of the value found there — the MISSING ≠ NULL distinction the file
 * header explains. `valueAtPath` deliberately cannot answer this question.
 */
function pathExists(obj: unknown, path: string): { exists: boolean; value: unknown; missingAt?: string } {
  let cur: unknown = obj;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return { exists: false, value: undefined, missingAt: segs.slice(0, i + 1).join('.') };
    }
    if (!(segs[i] in (cur as Record<string, unknown>))) {
      return { exists: false, value: undefined, missingAt: segs.slice(0, i + 1).join('.') };
    }
    cur = (cur as Record<string, unknown>)[segs[i]];
  }
  return { exists: true, value: cur };
}

/** Every path a cell DECLARES into its resolver's payload, labelled for the failure message. */
function declaredPaths(spec: CellSpec): Array<{ label: string; path: string; optional?: boolean }> {
  const out: Array<{ label: string; path: string; optional?: boolean }> = [
    { label: 'headline', path: spec.headline },
    { label: 'falsifier.field', path: spec.falsifier.field },
  ];
  if (spec.changeSignal.kind === 'poll') out.push({ label: 'changeSignal.path', path: spec.changeSignal.path });
  if (spec.unknownHoist) out.push({ label: 'unknownHoist', path: spec.unknownHoist });
  if (spec.materiality?.path) out.push({ label: 'materiality.path', path: spec.materiality.path });
  /**
   * WI-36259 — walked too, or this sweep would watch the wrong set: its own sibling test
   * (declared-consumed-sweep) calls that "THE COVERAGE VACUITY", and a new declared path
   * nobody walks is exactly the drift this file exists to catch.
   *
   * ⚠ OPTIONAL, and the distinction is real rather than a convenience. A source label
   * ATTRIBUTES a headline, so it exists only when there is a headline to attribute — for
   * the gate candidate that means only while a run is in flight. Asserting its presence
   * would make this suite pass or fail on whether a gate run happens to be live at the
   * moment it runs: green all afternoon, red at 03:00, with no code change either way.
   * A guard that flakes on ambient state is worse than no guard, because the first red
   * teaches everyone to re-run it.
   *
   * So the leaf is allowed to be absent and the PARENT is not — which is what actually
   * catches the drift (a renamed or mistyped container), while the value's own production
   * is pinned by the reconcileGateCandidates tests in git-pipeline-position.test.ts.
   */
  if (spec.headlineSource?.path) out.push({ label: 'headlineSource.path', path: spec.headlineSource.path, optional: true });
  return out;
}

const PIPELINE_CELLS = BUILTIN_CELLS.filter((c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'dev:pipeline_position');
const GOAL_CELLS = BUILTIN_CELLS.filter((c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'coord:goal');
const HOST_MEMORY_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'host:memory_pressure',
);
const COVERAGE_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'testing:coverage',
);

/**
 * The `dev:pipeline_position` handler spreads the resolver result unmodified
 * (`return { data: { ...result, ... } }`, pipeline_position.ts:173) and
 * `dispatchReadOnlyTool` unwraps `data`, so the resolver's own result IS the
 * payload the declared paths are walked against for this family. Driving the
 * resolver directly keeps the check free of a DB/dispatch dependency without
 * substituting a fixture for the shape under test.
 */
async function livePipelinePayload(path?: string) {
  return gitPipelinePosition(path === undefined ? {} : { path });
}

/**
 * Drive the real `testing:coverage` handler against the live census tables.
 *
 * `limit: 1` because the ROW LIST is irrelevant to a path walk and this suite should not
 * pull 1,105 rows to check six key names — the aggregates it walks are computed in SQL
 * over the whole population regardless of this argument, which is itself one of the
 * properties the tool's own suite pins.
 */
async function liveCoveragePayload(): Promise<unknown> {
  // `.data` — the handler returns a `{ data }` envelope and `dispatchReadOnlyTool` unwraps
  // it, so THAT unwrapped object is what readCell walks. Walking the envelope instead would
  // report every declared path missing at its first segment: a confident false alarm of
  // exactly the kind this file's header warns about for `agent.goal`.
  const result = (await (
    coverageTool as unknown as { handler: (args: unknown) => Promise<{ data: unknown }> }
  ).handler({ limit: 1 }));
  return result.data;
}

/** Drive the actual poll-tool handler because that serialized payload is what readCell walks. */
async function liveHostMemoryPayload(): Promise<unknown> {
  const result = await (
    hostMemoryPressureTool as unknown as {
      handler: (
        args: unknown,
        context: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).handler({}, {});
  return JSON.parse(result.content[0].text);
}

describe('P-011: every registered cell declares paths its resolver ACTUALLY produces', () => {
  /**
   * NON-VACUITY, and it is not ceremony here. P-009 found that every scanning guard
   * on this plane mutation-tested its predicate exhaustively while asserting NOTHING
   * about the size of its corpus — so a filter that silently matched nothing would
   * have left the suite green with zero cells examined. These two counts are the
   * only thing standing between that and a false all-clear.
   */
  it('examines the WHOLE registry — no cell is silently unrouted', () => {
    expect(BUILTIN_CELLS.length).toBeGreaterThanOrEqual(6);
    expect(
      PIPELINE_CELLS.length + GOAL_CELLS.length + HOST_MEMORY_CELLS.length + COVERAGE_CELLS.length,
    ).toBe(BUILTIN_CELLS.length);
    expect(PIPELINE_CELLS.length).toBeGreaterThanOrEqual(5);
    expect(GOAL_CELLS.length).toBeGreaterThanOrEqual(1);
    expect(HOST_MEMORY_CELLS).toHaveLength(1);
    expect(COVERAGE_CELLS).toHaveLength(2);
  });

  /**
   * THE ASSERTION THE EXISTING SUITE CANNOT MAKE. Driven against a LIVE resolver run,
   * which is the same standard axis 4 imposes on registration itself: this registry
   * refuses a cell registered on fixture evidence alone (cell-registry.ts:85), so its
   * own declarations are held to it too.
   */
  it.each(PIPELINE_CELLS.map((c) => [c.cell, c] as const))(
    '%s — every declared path exists in a live dev:pipeline_position payload',
    async (_id, spec) => {
      // A `parameter`-relative cell is dispatched WITH its subject; a `global` one with
      // `{}` (argsForRelativity, cell-read.ts:440) — and the no-arg call is legal
      // precisely so the global cells resolve (pipeline_position.ts:75-94). Reproducing
      // that split matters: the per-path legs are reported unmeasured on a no-arg call.
      const payload = await livePipelinePayload(
        spec.callerRelativity.kind === 'parameter' ? 'packages/operator-core/lib/cell-registrations.ts' : undefined,
      );
      for (const { label, path, optional } of declaredPaths(spec)) {
        // An optional-by-design leaf (see declaredPaths) is checked one level up: the
        // CONTAINER must be real, which is the drift this catches, while the leaf's
        // absence is a legitimate runtime state rather than a broken declaration.
        const target = optional ? path.split('.').slice(0, -1).join('.') : path;
        if (optional && target === '') continue;
        const r = pathExists(payload, target);
        expect(
          r.exists,
          `${spec.cell}: declared ${label} "${path}" is ABSENT from the live resolver payload ` +
            `(missing at "${r.missingAt}"${optional ? `; checked its container "${target}" because this path is optional-by-design` : ''}). ` +
            `The cell is unreadable: readCell would report insufficient-data. ` +
            `Either the resolver's shape changed or the declaration has a typo — a declaration test cannot tell you.`,
        ).toBe(true);
      }
    },
    20_000,
  );

  /**
   * deterministic-coverage-census-2026-08-17 P-005.
   *
   * ⚠ THE NULLABLE-LEAF CASE IS THE POINT HERE, not an edge. `testing.coverage.floor`'s
   * headline `coverage.pct` is null by design whenever the census is empty, and its
   * `censusUnknown` hoist is null whenever it is not — so on ANY given run one of the two
   * is null, and a walker that confused MISSING with NULL would report this cell broken
   * roughly half the time. `pathExists` walks own-keys precisely so it does not, and this
   * family is the first to depend on that distinction rather than merely benefit from it.
   *
   * The census is genuinely allowed to be empty when this runs (it is on a fresh
   * checkout, and was repo-wide until 2026-08-18), which is why the assertion is about
   * the SHAPE the handler always produces and never about a row count.
   */
  it.each(COVERAGE_CELLS.map((c) => [c.cell, c] as const))(
    '%s — every declared path exists in the real testing:coverage handler payload',
    async (_id, spec) => {
      const payload = await liveCoveragePayload();
      for (const { label, path } of declaredPaths(spec)) {
        const r = pathExists(payload, path);
        expect(
          r.exists,
          `${spec.cell}: declared ${label} "${path}" is ABSENT from the live resolver payload ` +
            `(missing at "${r.missingAt}"). Note this asserts PRESENCE, not a non-null value: ` +
            `coverage.pct is null over an empty census by design, and that is a readable answer, ` +
            `not drift.`,
        ).toBe(true);
      }
    },
    20_000,
  );

  it.each(HOST_MEMORY_CELLS.map((c) => [c.cell, c] as const))(
    '%s — every declared path exists in the real host:memory_pressure handler payload',
    async (_id, spec) => {
      const payload = await liveHostMemoryPayload();
      for (const { label, path } of declaredPaths(spec)) {
        const r = pathExists(payload, path);
        expect(
          r.exists,
          `${spec.cell}: declared ${label} "${path}" is ABSENT from the live resolver payload ` +
            `(missing at "${r.missingAt}").`,
        ).toBe(true);
      }
    },
    20_000,
  );

  /**
   * The falsifier's INDEPENDENCE, proved at the derivation rather than asserted about
   * the string. Axis 1 forbids a falsifier "derived from the headline", but
   * `validateCellSpec` can only check that one string does not contain the other —
   * which passes happily for a field that is computed FROM the headline under a
   * different name. That is not hypothetical: `git.pipelinePosition` records
   * (cell-registrations.ts:59-68) that `stages[].health` was the near-miss, because
   * for the serving stage it IS computed from this very falsifier.
   *
   * ⚠ Mutating the returned payload would prove NOTHING — it is already-serialised
   * JSON, so every derived value is frozen and "the falsifier did not move" is
   * true by construction. Independence is a property of the INPUTS, so the only
   * honest experiment moves an input: `probeUnitStart` is a live systemd probe that
   * shares no input with any git read, and `PipelinePositionDeps` exposes it as a
   * test seam for exactly this (git-pipeline-position.ts:1584-1590).
   */
  it('serving.startedSinceCodeChange moves with the PROCESS probe while the git headline stays put', async () => {
    const base = { path: 'packages/operator-core/lib/cell-registrations.ts' };

    /**
     * ⚠ The pivot is READ FROM THE LIVE RUN, not chosen. `codeAsOfMs` comes from the
     * DEPLOY state here (`codeAsOfSource: 'deploy'`), so injecting `fileMtimeMs` does
     * not move it and a hardcoded constant silently compares against the wrong instant
     * — which is how the first draft of this test failed. Anchoring to the resolver's
     * own reported value keeps the experiment valid whatever the box's deploy age.
     */
    const observed = await gitPipelinePosition(base);
    const codeAsOfMs = pathExists(observed, 'serving.codeAsOfMs').value;
    expect(typeof codeAsOfMs, 'the serving leg reported no codeAsOfMs — nothing to pivot on').toBe('number');
    const pivot = codeAsOfMs as number;

    // A process that started AFTER the code landed → the falsifier agrees with "deployed".
    const fresh = await gitPipelinePosition(base, {
      probeUnitStart: async () => ({ pid: 4242, startedAtMs: pivot + 60 * 60_000 }),
    });
    // The SAME git inputs, only the process probe moved → the falsifier must flip.
    const stale = await gitPipelinePosition(base, {
      probeUnitStart: async () => ({ pid: 4242, startedAtMs: pivot - 60 * 60_000 }),
    });

    expect(pathExists(fresh, 'serving.startedSinceCodeChange').value).toBe(true);
    expect(pathExists(stale, 'serving.startedSinceCodeChange').value).toBe(false);

    // ...while the headline both cells hang off did NOT move. If it had, the falsifier
    // would be sharing an input with the headline and axis 1 would be violated in fact.
    expect(pathExists(stale, 'positions.deployed').value).toEqual(pathExists(fresh, 'positions.deployed').value);
    expect(pathExists(stale, 'deployedSha').value).toEqual(pathExists(fresh, 'deployedSha').value);
  }, 30_000);

  /**
   * THE FALSIFIER FIRED — the plan item's literal demand, for the two cells that name
   * this measurement. `kills` states the false reading in prose; this constructs it and
   * shows the falsifier contradicting it, so the pairing is load-bearing rather than
   * commentary. CLAUDE.md carries the same correction ("deployed ✓" ≠ live) after it
   * was filed four separate times, and P-010 hit it AGAIN this session: a fix that was
   * committed, on staging, in main and reported `deployed ✓` had never been loaded,
   * because bg-host runs tsx from the staging tree and was never restarted.
   */
  it('kills "deployed ✓ means the running process has my code" — the misread filed 4× and re-hit by P-010', async () => {
    const base = { path: 'packages/operator-core/lib/cell-registrations.ts' };
    const pivot = pathExists(await gitPipelinePosition(base), 'serving.codeAsOfMs').value as number;
    expect(typeof pivot).toBe('number');

    const naiveReading = await gitPipelinePosition(base, {
      // The false reading, constructed: the code IS deployed, and a reader who stops
      // at the headline concludes the serving process is executing it. The process in
      // fact started three hours BEFORE that code existed — P-010's bg-host exactly.
      probeUnitStart: async () => ({ pid: 4242, startedAtMs: pivot - 3 * 60 * 60_000 }),
    });

    const falsifier = pathExists(naiveReading, 'serving.startedSinceCodeChange');
    expect(falsifier.exists).toBe(true);
    // The contradiction, stated as the assertion: the independent process measurement
    // says NO for a tree state the git headline is perfectly happy about.
    expect(falsifier.value).toBe(false);

    // And it is not a bare `false` a caller must interpret — the resolver quantifies the
    // gap, which is what makes the falsifier actionable rather than merely contradictory.
    expect(pathExists(naiveReading, 'serving.behindMin').value).toBeGreaterThan(0);

    // ⚠ A filter that matches NOTHING makes the loop below vacuous and this test green
    // for the wrong reason — the exact defect P-009 found in all four of this plane's
    // scanning guards (every one mutation-tested its predicate and none asserted the
    // SIZE of its corpus). Caught here by mutation-testing this very file: renaming the
    // falsifier path emptied the filter and the loop still "passed".
    const sharing = PIPELINE_CELLS.filter((c) => c.falsifier.field === 'serving.startedSinceCodeChange');
    expect(sharing.length, 'no cell falsifies via serving.startedSinceCodeChange — this assertion checked nothing').toBeGreaterThanOrEqual(2);
    for (const spec of sharing) {
      expect(spec.falsifier.kills.toLowerCase()).toContain('deployed');
    }
  }, 30_000);
});

/**
 * `agent.goal` resolves through a DIFFERENT tool, so it gets its own describe rather
 * than a skipped row in the table above — a cell quietly filtered out of a generic
 * loop is precisely the "falsifier nobody has fired" this item is about.
 *
 * The resolver is mocked, the PAYLOAD BUILDER is not: the assertions run against the
 * real `coord:goal` handler's object construction (goal.ts:57-90), so a change to the
 * hoisting it performs reds this file. Mocking only the DB-backed leg keeps that real
 * without requiring Postgres.
 */
vi.mock('./agent-tools/coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-p011', ownerLabel: 'su · p011', source: 'test', workspaceId: 'default', userId: null }),
  SU_ROLES: ['operator'],
}));

const resolveOwnerGoalMock = vi.hoisted(() => vi.fn());
vi.mock('./agent-tools/coordination/agent-goal-sources', () => ({
  resolveOwnerGoal: resolveOwnerGoalMock,
}));

describe('P-011: agent.goal declares paths coord:goal ACTUALLY produces', () => {
  async function goalPayload(goal: unknown): Promise<unknown> {
    resolveOwnerGoalMock.mockResolvedValue(goal);
    const { default: goalTool } = await import('./agent-tools/coordination/tools/goal');
    const res = await (goalTool as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(
      { ownerId: 'su-p011' },
      { workspaceId: 'default', harnessSlug: 'papercusp', uiClientId: 'su-p011' },
    );
    return JSON.parse(res.content[0].text);
  }

  const HELD_GOAL = {
    ref: 'WI-6498',
    source: 'work-item',
    agreement: 'divergent',
    competing: ['WI-6497'],
    corroboratedBy: ['claim'],
    declaredAt: '2026-07-27T22:00:00.000Z',
  };

  /**
   * ⚠ THE CASE THAT WOULD ACTUALLY BREAK, and the reason both branches are tested.
   * An agent holding NOTHING is the ordinary case, and it is the one where a nested
   * declaration silently dies: `valueAtPath` bails at the first null segment, so a
   * headline of `goal.ref` against `goal: null` yields undefined and `readCell`
   * announces the resolver's shape has "drifted apart" from the cell — a confident
   * false diagnosis of a healthy system. A fixture with a goal in it passes either way,
   * which is exactly how this would ship.
   */
  it.each(GOAL_CELLS.map((c) => [c.cell, c] as const))(
    '%s — every declared path exists whether or not the agent holds anything',
    async (_id, spec) => {
      for (const [caseName, goal] of [['holds a goal', HELD_GOAL], ['holds NOTHING', null]] as const) {
        const payload = await goalPayload(goal);
        for (const { label, path } of declaredPaths(spec)) {
          const r = pathExists(payload, path);
          expect(
            r.exists,
            `${spec.cell} (${caseName}): declared ${label} "${path}" is ABSENT from the coord:goal payload ` +
              `(missing at "${r.missingAt}").`,
          ).toBe(true);
        }
      }
    },
  );

  /** The hoist is the load-bearing half: flat, and non-null exactly when there is no goal. */
  it('reads null-with-a-reason rather than a drift error for an agent holding nothing', async () => {
    const empty = await goalPayload(null);
    expect(pathExists(empty, 'goalRef')).toEqual({ exists: true, value: null });
    expect(pathExists(empty, 'goalUnknown').value).toBe('nothing-held');

    const held = await goalPayload(HELD_GOAL);
    expect(pathExists(held, 'goalRef').value).toBe('WI-6498');
    expect(pathExists(held, 'goalUnknown').value).toBeNull();
  });

  /**
   * THE FALSIFIER FIRED for this cell. The false reading `kills` names is "the goal ref
   * is THE thing they are working on" — which a reader takes from the headline alone.
   * `goal.agreement` is the independent measurement (the coord_links edge, not
   * staleness), and it contradicts that reading by reporting the ref stands among
   * COMPETING claims rather than a corroborated one.
   */
  it.each(GOAL_CELLS.map((c) => [c.cell, c] as const))(
    '%s — the falsifier contradicts "the ref is the whole story"',
    async (_id, spec) => {
      const payload = await goalPayload(HELD_GOAL);

      // The naive reading: a single confident ref.
      expect(pathExists(payload, spec.headline).value).toBe('WI-6498');

      // The falsifier, read at its DECLARED path, contradicting it.
      const f = pathExists(payload, spec.falsifier.field);
      expect(f.exists).toBe(true);
      expect(f.value).toBe('divergent');
      expect(pathExists(payload, 'goal.competing').value).toEqual(['WI-6497']);

      // A corroborated holder must NOT read as divergent, or the falsifier would be a
      // constant — which fires on everything and therefore distinguishes nothing.
      const corroborated = await goalPayload({ ...HELD_GOAL, agreement: 'corroborated', competing: [] });
      expect(pathExists(corroborated, spec.falsifier.field).value).toBe('corroborated');
    },
  );
});
