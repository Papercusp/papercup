import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateCellSpec,
  getCell,
  listCellsUnchecked,
  __resetCellRegistryForTests,
  type CellSpec,
} from './cell-registry';
import {
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_OWNERSHIP_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
  AGENT_GOAL_CELL,
  HOST_MEMORY_PRESSURE_CELL,
  BUILTIN_CELLS,
  registerBuiltinCells,
} from './cell-registrations';

const OPERATOR_PIPELINE_CELLS = [
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_OWNERSHIP_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
];

/**
 * P-006. The value of this suite is not "a cell is registered" — it is that the
 * FLAGSHIP cell, the one the contract was partly derived from, passes the contract's
 * own gate honestly rather than by declaring its way around it.
 */
describe('P-006: git.pipelinePosition registers under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates with zero rejections', () => {
    expect(validateCellSpec(GIT_PIPELINE_POSITION_CELL)).toEqual([]);
  });

  it('registers and is retrievable', () => {
    registerBuiltinCells();
    // P-019: the cell describes the operator HOME Pot's checkout, not every
    // independently-managed harness that happens to share this workspace.
    expect(getCell('git.pipelinePosition', { ownerId: 'su-anyone', harnessSlug: 'papercusp' })?.resolver).toContain(
      'gitPipelinePosition()',
    );
  });

  it('is idempotent — registering the built-ins twice does not throw', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
  });

  /**
   * THE REGRESSION THAT MATTERS. `nullable: true` is only honest because the resolver
   * now HOISTS its unreadable legs. If someone later removes `positionsUnknown` from
   * the result and drops the declaration with it, this cell silently reverts to
   * claiming a two-valued headline that is in fact three-valued — which is precisely
   * the state P-006 found it in.
   */
  it('declares the unknown hoist, and is REJECTED without it', () => {
    expect(GIT_PIPELINE_POSITION_CELL.nullable).toBe(true);
    expect(GIT_PIPELINE_POSITION_CELL.unknownHoist).toBe('positionsUnknown');

    const withoutHoist = { ...GIT_PIPELINE_POSITION_CELL, unknownHoist: undefined };
    const rejections = validateCellSpec(withoutHoist);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ axis: 2, rule: 'unknown-not-hoisted' });
  });

  /**
   * The independence INTENT, surviving P-006's deletion of the axis that used to
   * police it. The specific mistake it is locked against is unchanged: substantiating
   * the headline with `stages[].health`, which for the serving stage is COMPUTED FROM
   * the headline and therefore adds no new information.
   *
   * ⚠ This is now a claim about the SHIPPED REGISTRATION, not about a validator. P-006
   * deleted axis 1 along with the falsifier, so `validateCellSpec` no longer refuses a
   * self-substantiating cell — asserting that it does would pin a rule that is gone.
   * What still holds, and is worth pinning, is that this cell's declared evidence names
   * measurements the headline does not already contain.
   */
  it('substantiates its assessment from measurements independent of the headline', () => {
    const a = GIT_PIPELINE_POSITION_CELL.assessment;
    expect(a).not.toBeNull();
    expect(a!.evidence.length).toBeGreaterThan(0);
    for (const path of a!.evidence) expect(path).not.toBe(GIT_PIPELINE_POSITION_CELL.headline);
    // The assessment path is a third field, distinct from the headline it interprets.
    expect(a!.path).not.toBe(GIT_PIPELINE_POSITION_CELL.headline);
  });

  /** Axis 3: `parameter`, said out loud. Inference would have concluded `global`. */
  it('declares caller-relativity explicitly rather than leaving it inferred', () => {
    expect(GIT_PIPELINE_POSITION_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'path' });
  });
});

/**
 * P-007. Four sibling cells over the SAME resolver (#D-065). What is worth testing is
 * not that five specs validate — the constructor would have thrown at import time — but
 * the handful of properties that would silently regress into a confidently-wrong cell.
 */
describe('P-007: the four verdict cells', () => {
  beforeEach(() => __resetCellRegistryForTests());

  const NEW_CELLS = [GATE_VERDICT_CELL, GATE_CANDIDATE_CELL, DEPLOYED_SHA_CELL, MAIN_BEHIND_STAGING_CELL];

  it.each(OPERATOR_PIPELINE_CELLS.map((c) => [c.cell, c] as const))(
    '%s is visible only inside the operator home harness',
    (id, spec) => {
      expect(spec.visibility).toEqual({ kind: 'harness', ref: 'papercusp' });
      registerBuiltinCells();
      expect(getCell(id, { ownerId: 'su-inside', harnessSlug: 'papercusp' })).toBeDefined();
      expect(getCell(id, { ownerId: 'su-outside', harnessSlug: 'sidestage' })).toBeUndefined();
    },
  );

  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s validates with zero rejections', (_id, spec) => {
    expect(validateCellSpec(spec)).toEqual([]);
  });

  it('registers every built-in, and does so idempotently', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
    expect(listCellsUnchecked().map((c) => c.cell)).toEqual([
      // P-016. The first cell here that is about an AGENT rather than the tree.
      'agent.goal',
      'deploy.3070.sha',
      'gate.greenCheckpoint.candidate',
      // D-014. Its own cell, and deliberately NOT part of the pipeline family
      // below: it resolves via readGateOwnership(), not gitPipelinePosition(),
      // because it derives WHO owns the red from lease + presence state rather
      // than from the tree. Registered here; excluded from NEW_CELLS on purpose.
      'gate.greenCheckpoint.ownership',
      'gate.greenCheckpoint.verdict',
      'git.mainBehindStaging',
      'git.pipelinePosition',
      'host.memoryPressure',
      // deterministic-coverage-census-2026-08-17 P-005. A PAIR, split along the line
      // between a count and a ratio: the population is never unknown (it is a row
      // count, so 0 is a measurement), while the ratio has no answer at all when that
      // population is 0. One cell could not state both truths.
      'testing.census.population',
      'testing.coverage.floor',
    ]);
  });

  /**
   * P-006 — THE CHECK REGISTRATION DELIBERATELY DOES NOT DO.
   *
   * `validateCellSpec` never resolves a pointer's target, because doing so would make a
   * same-module pointer depend on declaration order — and the order authors naturally
   * write (the general cell first, the specific one it points at second) is exactly the
   * one that would fail. The cost of that choice is that a TYPO registers silently. This
   * is what pays it: over the REAL registry, after every built-in is loaded, every
   * declared pointer must name a cell that exists.
   *
   * Without this, `pointers` degrades in the worst direction available to it — a door
   * that is confidently advertised and opens onto nothing, in the one situation (a red
   * gate) where the reader is least able to afford a wild goose chase.
   */
  it('every SHIPPED pointer resolves to a registered cell', () => {
    registerBuiltinCells();
    const cells = listCellsUnchecked();

    /**
     * Extracted so the CONTROL below drives the identical expression. A guard asserting
     * `[]` passes just as happily when it is looking at nothing — if `pointers` were
     * renamed or dropped, `c.pointers ?? []` would yield an empty set forever and this
     * test would keep printing green while measuring nothing. The control is what
     * separates "no dangling pointers" from "no pointers examined".
     */
    const danglingIn = (specs: readonly CellSpec[]) => {
      const registered = new Set(cells.map((c) => c.cell));
      return specs.flatMap((c) =>
        (c.pointers ?? []).filter((p) => !registered.has(p.cell)).map((p) => `${c.cell} -> ${p.cell}`),
      );
    };

    expect(danglingIn(cells)).toEqual([]);

    // CONTROL — the same detector, on a spec whose pointer names nothing. If this stops
    // failing, the assertion above has stopped being able to fail too.
    const planted: CellSpec = {
      ...GATE_VERDICT_CELL,
      cell: 'control.planted',
      pointers: [{ cell: 'no.such.cell', when: 'always', answers: 'nothing — this is a control' }],
    };
    expect(danglingIn([planted])).toEqual(['control.planted -> no.such.cell']);

    // CALIBRATION — and the control's own premise: the REAL pointers must be non-empty,
    // or the population under test is empty and the green above is vacuous.
    expect(cells.flatMap((c) => c.pointers ?? []).length).toBeGreaterThan(0);
  });

  /**
   * The POSITIVE assertion, kept separate from the integrity check above: that check
   * passes vacuously if the pointers are ever dropped, and a silently-dropped pointer is
   * indistinguishable from a working one at the call site. This names the specific route
   * P-006 exists to create — from the two cells an agent reads on a red gate, TO the cell
   * that says who owns it (owner directive 2026-08-08: "surface it where agents look").
   */
  it('both red-gate cells route to the ownership cell', () => {
    for (const cell of [GATE_VERDICT_CELL, GATE_CANDIDATE_CELL]) {
      expect(cell.pointers?.map((p) => p.cell)).toEqual(['gate.greenCheckpoint.ownership']);
    }
  });

  it('the candidate ownership pointer states its advisory condition as a conditional, never a fact', () => {
    const pointer = GATE_CANDIDATE_CELL.pointers?.[0];
    expect(pointer?.when).toMatch(/^IF `judgingContainsPath` is true/);
    expect(pointer?.when).not.toMatch(/^`judgingContainsPath` is true/);
  });

  it('projects release:trace target.sha through the candidate cell', () => {
    expect(GATE_CANDIDATE_CELL.doorProjections).toEqual([{ tool: 'release:trace', path: 'target.sha' }]);
  });

  /**
   * D-014, asserted rather than trusted: ownership stays a CELL with its own declared
   * semantics, and the pointer is only a route to it. If someone ever "simplifies" this
   * by folding ownership into the verdict cell as extra evidence, this fails.
   */
  it('the pointer did NOT replace the ownership cell — it still owns its own assessment', () => {
    registerBuiltinCells();
    const ownership = listCellsUnchecked().find((c) => c.cell === 'gate.greenCheckpoint.ownership');

    expect(ownership).toBeDefined();
    expect(ownership!.assessment).not.toBeNull();
    expect(ownership!.assessment!.evidence).toContain('gate.ownership.holderSessionState');
    // ...and the cell pointing AT it substantiates its own, unrelated claim. THE INTENT
    // is "not the ownership cell's evidence" — the ancestry field it names is incidental
    // and was legitimately repointed to the polarity-correct projection
    // (EI-20046248345042252), so assert the intent explicitly rather than leaving a bare
    // literal that reads as a break the next time the sign is corrected.
    expect(GATE_VERDICT_CELL.assessment).not.toBeNull();
    expect(GATE_VERDICT_CELL.assessment!.evidence).not.toContain('gate.ownership.holderSessionState');
    expect(GATE_VERDICT_CELL.assessment!.evidence).toContain('verdictProvenance.mainBehindStaging');
  });

  /**
   * #D-065 IS THE ASSERTION. Five cells naming one resolver is axis 5 satisfied (many
   * lenses over one derivation), and the thing that would break it is someone "fixing"
   * a cell by pointing it at a second resolver — or at a hand-rolled re-derivation of
   * the same values, which is the failure axis 5 exists to prevent.
   *
   * ⚠ SCOPED TO THE PIPELINE FAMILY, not to BUILTIN_CELLS. P-016's `agent.goal`
   * legitimately has its OWN resolver — it derives a different thing from
   * different tables. Asserting "the registry has exactly one resolver" would
   * therefore be asserting that no second SUBJECT may ever be registered, which is
   * not what D-065 said and would block the registry from growing at all. The
   * invariant that matters is that the pipeline cells do not sprout a second
   * derivation among THEMSELVES.
   */
  it('the pipeline family are all lenses over the ONE gitPipelinePosition resolver', () => {
    const family = [GIT_PIPELINE_POSITION_CELL, ...NEW_CELLS];
    const resolvers = new Set(family.map((c) => c.resolver));
    expect(resolvers.size).toBe(1);
    expect([...resolvers][0]).toContain('gitPipelinePosition()');
  });

  /** Every registered cell still names exactly one resolver of its own — the
   *  per-cell half of axis 5, which the family assertion above no longer covers. */
  it('no two cells share a cell id, and every cell names a resolver', () => {
    expect(new Set(BUILTIN_CELLS.map((c) => c.cell)).size).toBe(BUILTIN_CELLS.length);
    for (const c of BUILTIN_CELLS) expect(c.resolver.trim()).not.toBe('');
  });

  /**
   * THE REGRESSION THAT MATTERS MOST, and the one this item nearly shipped wrong.
   *
   * `gate.consecutiveReds` is typed `number`, so `nullable: false` is literally true of
   * the shipped type and passes this gate with zero rejections — the exact incentive the
   * P-006 note records ("the gate rewarded the weaker cell"). It is nullable because
   * `git-pipeline-stats` applies `?? 0` to an absent counter, making a `0` that reads as
   * a passing gate. If someone later removes the hoist because "the type says number",
   * this fails.
   */
  it('declares the reds counter NULLABLE despite its non-null type, and is rejected without the hoist', () => {
    expect(GATE_VERDICT_CELL.nullable).toBe(true);
    expect(GATE_VERDICT_CELL.unknownHoist).toBe('verdictUnknown');

    const rejections = validateCellSpec({ ...GATE_VERDICT_CELL, unknownHoist: undefined });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ axis: 2, rule: 'unknown-not-hoisted' });
  });

  /** Every one of the four degrades into GOOD NEWS, so every one must hoist. */
  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s hoists its unknown', (_id, spec) => {
    expect(spec.nullable).toBe(true);
    expect(spec.unknownHoist).toBeTruthy();
  });

  /**
   * The gate tally CITES the ancestry check as evidence — each is different apparatus
   * (a test-verdict tally vs. a git ancestry walk), and the pairing is worth pinning
   * because it looks like a mistake to a later reader who might "fix" it into a
   * self-substantiating cell.
   *
   * ⚠ Post-P-006 this asserts the shipped DECLARATIONS, not a validator: axis 1 was
   * deleted with the falsifier, so `validateCellSpec` no longer refuses a cell that
   * substantiates itself. The per-cell loop below is what still catches that.
   */
  it('substantiates the gate tally with the ancestry check, and no cell with itself', () => {
    expect(GATE_VERDICT_CELL.assessment).not.toBeNull();
    expect(GATE_VERDICT_CELL.assessment!.evidence).toContain(MAIN_BEHIND_STAGING_CELL.headline);
    expect(MAIN_BEHIND_STAGING_CELL.assessment).not.toBeNull();
    expect(MAIN_BEHIND_STAGING_CELL.assessment!.evidence).not.toContain(GATE_VERDICT_CELL.headline);
    // Independence is per-cell: no cell may substantiate its own headline with itself.
    for (const spec of NEW_CELLS) {
      expect(spec.assessment).not.toBeNull();
      expect(spec.assessment!.path).not.toBe(spec.headline);
      expect(spec.assessment!.evidence).not.toContain(spec.headline);
    }
  });

  /**
   * EI-20046248345042252 — this cell answered its own NAME BACKWARDS. It headlined
   * `verdictProvenance.mainFastForwarded`, which is the same measurement in the opposite
   * polarity, so `state:read { cell: 'git.mainBehindStaging' }` returned `false` while
   * main sat 22 commits behind staging (measured 2026-08-10). Because
   * `greenPinAtStagingHead` is false in the fleet's normal steady state, the wrong answer
   * was the STANDING one rather than an edge case.
   *
   * This pins the PROPERTY — a reader who follows the headline path gets the answer the
   * cell's NAME asks for — rather than the spelling of a field, which is what a rename
   * would sail straight through. It carries its own CONTROL so it cannot pass vacuously.
   */
  it('headlines a field whose polarity matches the cell NAME (main behind => true)', () => {
    // The fleet's normal steady state: staging has outrun the green pin, so main IS
    // behind. That is exactly what `greenPinAtStagingHead === false` encodes.
    const mainIsBehind = {
      verdictProvenance: { mainFastForwarded: false, mainBehindStaging: true },
    };
    const read = (path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], mainIsBehind);

    expect(MAIN_BEHIND_STAGING_CELL.cell).toBe('git.mainBehindStaging');
    // THE ASSERTION THAT MATTERS: follow the headline, get the name's answer.
    expect(read(MAIN_BEHIND_STAGING_CELL.headline)).toBe(true);

    // CONTROL — the field it used to headline yields the OPPOSITE from the same fixture.
    // If this ever stops holding, the fixture has gone vacuous and the check above is
    // no longer evidence of anything.
    expect(read('verdictProvenance.mainFastForwarded')).toBe(false);

    // A change-signal left on the old path would poll the opposite sign, so a watcher
    // would fire on exactly the wrong transition.
    expect(MAIN_BEHIND_STAGING_CELL.changeSignal).toMatchObject({
      path: MAIN_BEHIND_STAGING_CELL.headline,
    });
  });

  /**
   * Axis 3 differs ACROSS cells that share a resolver, which is the concrete evidence
   * that relativity belongs to the cell and not the derivation: the candidate cell is
   * per-path, the other three are global. An author copying a spec would get this wrong.
   */
  it('declares caller-relativity per CELL, not per resolver', () => {
    expect(GATE_CANDIDATE_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'path' });
    expect(GATE_VERDICT_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(DEPLOYED_SHA_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(MAIN_BEHIND_STAGING_CELL.callerRelativity).toEqual({ kind: 'global' });
  });

  /**
   * EI-11012 / why-chain.ts: a nonzero staging buffer is the NORMAL steady state, and
   * the naive "behind = broken" reading made the deploy stage report degraded
   * essentially always, shadowing every real cause. The `kills` text is the only place
   * that correction is carried to a cell author, so pin its direction.
   */
  it('kills the "lag means stalled" misreading, not the naive inverse', () => {
    const kills = MAIN_BEHIND_STAGING_CELL.falsifier.kills.toLowerCase();
    expect(kills).toContain('normal steady state');
    expect(MAIN_BEHIND_STAGING_CELL.falsifier.measurement).toContain('SCHEDULER-LIVENESS');
  });

  /** Axis 4 admits no fixture-only registration, and every one of these four carries a
   *  verbatim live read rather than a promise that one happened. */
  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s cites a real live exercise', (_id, spec) => {
    expect(spec.provenance.liveExercised).toBe(true);
    expect(spec.provenance.evidence).toContain('dev:pipeline_position');
    expect(spec.provenance.evidence).toMatch(/2026-07-27/);
  });
});

describe('EI-20449419111876508: host.memoryPressure is a readable shared-writer cell', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates and registers under the workspace-visible global contract', () => {
    expect(validateCellSpec(HOST_MEMORY_PRESSURE_CELL)).toEqual([]);
    registerBuiltinCells();
    expect(getCell('host.memoryPressure', { ownerId: 'su-anyone' })).toEqual(
      HOST_MEMORY_PRESSURE_CELL,
    );
    expect(HOST_MEMORY_PRESSURE_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(HOST_MEMORY_PRESSURE_CELL.visibility).toEqual({ kind: 'workspace' });
  });

  it('routes through the canonical memory writer and hoists incomplete inputs', () => {
    expect(HOST_MEMORY_PRESSURE_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'host:memory_pressure',
      path: 'memory.pressure',
    });
    expect(HOST_MEMORY_PRESSURE_CELL.resolver).toContain('evaluateMemoryPressure');
    expect(HOST_MEMORY_PRESSURE_CELL.nullable).toBe(true);
    expect(HOST_MEMORY_PRESSURE_CELL.unknownHoist).toBe('memory.unknown');
  });

  it('declares the in-process free-memory measurement as an independent falsifier', () => {
    expect(HOST_MEMORY_PRESSURE_CELL.falsifier.field).toBe('host.memFreePct');
    expect(HOST_MEMORY_PRESSURE_CELL.falsifier.field).not.toBe(
      HOST_MEMORY_PRESSURE_CELL.headline,
    );
    expect(HOST_MEMORY_PRESSURE_CELL.falsifier.measurement).toMatch(/freemem\(\)\/totalmem\(\)/);
  });
});

/**
 * P-016 — the agent goal cell.
 *
 * The assertions worth making here are the ones that would go red if someone
 * "simplified" the cell back to the plan item's literal wording. The precedence
 * sentence is under-determined on the live fleet, and the falsifier is what
 * carries that finding to the next author.
 */
describe('P-016: agent.goal registers under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates with zero rejections', () => {
    expect(validateCellSpec(AGENT_GOAL_CELL)).toEqual([]);
  });

  it('registers and is retrievable by any reader — a blocked peer is the point', () => {
    registerBuiltinCells();
    expect(getCell('agent.goal', { ownerId: 'su-anyone' })?.resolver).toContain('resolveOwnerGoal()');
  });

  /**
   * Axis 3. The whole cell is "about WHICH agent", so a global or ambient
   * declaration would be a category error — and `cell-read.ts` names this cell as
   * the motivating example for the `subject` parameter.
   */
  it('is parameter-relative on ownerId, not global', () => {
    expect(AGENT_GOAL_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'ownerId' });
  });

  /**
   * Axis 1. The falsifier must be the LINK GRAPH, not staleness: staleness is
   * already carried by HolderContext rule (e), so reusing it would add
   * interpretation with no new information — which is what axis 1 rejects.
   */
  it('falsifies via the coord_links edge, and cites the measurement that earned it', () => {
    expect(AGENT_GOAL_CELL.falsifier.measurement).toContain('coord_links');
    expect(AGENT_GOAL_CELL.falsifier.measurement).not.toMatch(/stale/i);
    // The count is the load-bearing part: it is why precedence alone is not enough.
    expect(AGENT_GOAL_CELL.falsifier.kills).toContain('3 of 19');
  });

  /** Axis 2. A held-nothing agent has no goal, and the competing claims must be
   *  hoisted to the RESULT so a caller who skips `agreement` still cannot miss them. */
  it('is nullable and hoists the reason there is no goal', () => {
    expect(AGENT_GOAL_CELL.nullable).toBe(true);
    expect(AGENT_GOAL_CELL.unknownHoist).toBe('goalUnknown');
  });

  /**
   * ⚠ THE REGRESSION THIS PINS, and it is not cosmetic. `valueAtPath` returns
   * `undefined` the moment ANY path segment is null, so a nested headline like
   * `goal.ref` would make `readCell` answer `insufficient-data` for every agent
   * holding nothing — and that code's message tells the reader the resolver's
   * shape has "drifted apart" from the cell. A confidently wrong diagnosis of the
   * most ordinary case there is. Flattened, the same case reads `value: null`.
   *
   * Anyone "tidying" this back under the `goal` object reintroduces it silently,
   * because every fixture with a goal still passes.
   */
  it('keeps the headline path FLAT so a goal-less agent reads null, not a fake drift error', () => {
    expect(AGENT_GOAL_CELL.headline).toBe('goalRef');
    expect(AGENT_GOAL_CELL.headline).not.toContain('.');
    if (AGENT_GOAL_CELL.changeSignal.kind !== 'poll') throw new Error('expected a poll cell');
    expect(AGENT_GOAL_CELL.changeSignal.path).toBe('goalRef');
    expect(AGENT_GOAL_CELL.changeSignal.path).not.toContain('.');
  });

  /**
   * P-019. Narrowing this cell would make it useless for the thing D-051 built it
   * for — a BLOCKED PEER reading the holder's goal — while promising a secrecy
   * the claim surfaces do not actually provide.
   */
  it('is workspace-visible and hive-local', () => {
    expect(AGENT_GOAL_CELL.visibility).toEqual({ kind: 'workspace' });
    expect(AGENT_GOAL_CELL.federation).toEqual({ kind: 'local' });
  });

  /**
   * A registered cell with no dispatchable poll tool is unreadable forever —
   * `readCell` would return insufficient-data — which is the "surface #29"
   * failure D-010's adoption gate exists to prevent.
   */
  it('names a poll resolver so the cell is actually readable', () => {
    expect(AGENT_GOAL_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'coord:goal',
      path: 'goalRef',
    });
  });

  /** Axis 6 absent: the four SOURCES are a precedence, not a sequence. Declaring
   *  them as stages would invite reading `fleet-mission` as "further along". */
  it('declares no stage order', () => {
    expect(AGENT_GOAL_CELL.ordered).toBeUndefined();
  });

  it('is in BUILTIN_CELLS and does not collide with an existing resolver', () => {
    expect(BUILTIN_CELLS).toContain(AGENT_GOAL_CELL);
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
  });
});

/**
 * P-005 — REACH VERIFICATION over the REAL registry.
 *
 * Everything above validates cell DECLARATIONS. This asserts the property that
 * actually matters to an agent: that the audiences those cells declare are reachable
 * by the readers the documentation points at them. That is a different question, and
 * it was false in production for ten days with every declaration test green.
 *
 * WHAT WAS BROKEN. `CLAUDE.md` directs su agents at the six pipeline cells
 * (`gate.greenCheckpoint.*`, `git.*`, `deploy.3070.sha`) and tells them
 * `dev:pipeline_position` "HANDS YOU THE HANDLE" to re-read them. But an operator-scope
 * session presents `harnessSlug:'*'`, the harness check was a bare `===`, and so every
 * one of those cells read as `absent` — measured 418 distinct agents / 358,755 calls in
 * a 24h window. The plane block vanished with them, because `stampStatePlane` shares
 * this oracle. Both symptoms are pinned below, against the real specs rather than
 * fixtures, because a fixture is exactly what failed to catch this.
 */
describe('P-005 — declared audiences are actually reachable (real registry)', () => {
  beforeEach(() => {
    __resetCellRegistryForTests();
    registerBuiltinCells();
  });

  /** The identity a cross-harness su/superuser session really presents. Not invented:
   *  every `harnessSlug:'*'` caller in a measured 24h window carried role `operator`. */
  const operatorScope = { ownerId: 'su-p005', roles: ['operator'], harnessSlug: '*' };

  it('an operator-scope reader reaches EVERY registered cell', () => {
    // listCellsUnchecked is the sanctioned admin enumeration (P-005 names it): the probe
    // must see cells the reader cannot, or it could not detect one going unreachable.
    const unreachable = listCellsUnchecked()
      .filter((spec) => !getCell(spec.cell, operatorScope))
      .map((spec) => spec.cell);

    expect(
      unreachable,
      `these registered cells are UNREACHABLE by a normal operator-scope session ` +
        `(role=operator, harnessSlug='*'): ${unreachable.join(', ')}. Agents are pointed at ` +
        `these by name in CLAUDE.md and will get a bare "absent", which P-019 makes ` +
        `deliberately indistinguishable from "no such cell" — so the failure is silent.`,
    ).toEqual([]);
  });

  it('covers the six pipeline cells specifically, by name', () => {
    // The regression itself. Named individually so a failure says WHICH cell went dark.
    for (const spec of OPERATOR_PIPELINE_CELLS) {
      expect(getCell(spec.cell, operatorScope), `${spec.cell} unreadable`).toBeTruthy();
    }
  });

  it('the probe can still FAIL — a foreign-harness agent is refused', () => {
    // Calibration. Without this, a canReadCell that returned true unconditionally would
    // pass every assertion above, and the probe would be measuring nothing.
    const sidestage = { ownerId: 'su-other', roles: ['operator'], harnessSlug: 'sidestage' };
    for (const spec of OPERATOR_PIPELINE_CELLS) {
      expect(getCell(spec.cell, sidestage), `${spec.cell} leaked to a foreign harness`).toBeFalsy();
    }
    // ...and it is a REFUSAL, not an empty registry: the same reader still sees the
    // workspace-visible cells, so the negative above is about audience, not registration.
    expect(getCell(AGENT_GOAL_CELL.cell, sidestage)).toBeTruthy();
  });
});

describe('P-009 / D-013: no registered cell declares a federation nobody transports', () => {
  beforeEach(() => {
    __resetCellRegistryForTests();
  });

  it('every builtin cell is `local`', () => {
    // THE DRIFT GUARD. The validator refuses `shareable` at registration, but this
    // asserts the property over the REAL population rather than over a hand-built
    // spec — so it fails if someone lands a shareable cell by any route (including
    // flipping CELL_FEDERATION_TRANSPORT_AVAILABLE) without wiring a transport that
    // actually consumes spec.federation.
    const notLocal = BUILTIN_CELLS.filter((c) => c.federation?.kind !== 'local').map((c) => c.cell);
    expect(notLocal, `cells declaring a federation nothing transports: ${notLocal.join(', ')}`).toEqual([]);
  });

  it('measures the population from the registry, so a new cell cannot slip past it', () => {
    // Calibration, and NOT redundant with the assertion above: a filter over an EMPTY
    // array also returns [], so without this the guard would pass vacuously if
    // BUILTIN_CELLS were ever emptied or renamed. Measured 2026-08-21: 10 cells — and
    // a string-literal grep of cell-registrations.ts finds only 9 of them, because
    // agent.goal registers its name through the AGENT_GOAL_CELL_ID constant. That 10%
    // silent undercount is exactly why this counts the registry, never the source text.
    expect(BUILTIN_CELLS.length).toBeGreaterThanOrEqual(10);
    registerBuiltinCells();
    expect(listCellsUnchecked().length).toBe(BUILTIN_CELLS.length);
  });
});
