/**
 * start-from-package.test.ts — the P-017 package-start door's contract
 * (work-on-everything-goal-2026-08-23 P-017; D-002: install ≠ start).
 *
 * Idiom follows start-goal-by-id.test.ts: everything rides injected
 * StartGoalFromPackageDeps; the sql tag is inert because the core touches the
 * database only through deps. The typed-inputs gate (P-021) deliberately rides
 * the REAL evaluateGoalStartInputs so this door and `goals:start` cannot drift
 * into two notions of "ready", and the standing-defaults fold is tested as the
 * pure function it is (the P-022 construct() seam interposes there).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { LocalGoalPackage } from '../cupboard/goal-package-store';
import {
  effectiveGoalContent,
  startGoalFromPackage,
  STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC,
  STANDING_GOAL_HOLDER_DEFAULT,
  type GoalPackageContent,
  type StartGoalFromPackageDeps,
} from './start-from-package';

const SQL = {} as unknown as Sql;
const WS = 'ws-1';
const REF = 'work-on-everything';
const STUB_ID = 'work-on-everything-aaa111';

type Stub = Awaited<ReturnType<StartGoalFromPackageDeps['readInstances']>>[number];

function pkg(overrides: Partial<LocalGoalPackage> = {}): LocalGoalPackage {
  return {
    ref: REF,
    title: 'Work on everything',
    body: 'Steward the whole backlog.',
    standing: true,
    killCriterion: null,
    tripwires: null,
    budgetCents: null,
    budgetWindowSec: null,
    launchSettings: null,
    inputSchema: null,
    outputSchema: null,
    propertySchema: null,
    description: 'the standing steward',
    requiresRubrics: [],
    version: '1.2.0',
    source: 'bundled',
    dir: '/goal-packages/work-on-everything',
    layer: 'bundled',
    ...overrides,
  };
}

function stubRow(overrides: Partial<Stub> = {}): Stub {
  return {
    id: STUB_ID,
    title: 'Work on everything',
    status: 'paused',
    install_slug: 'papercusp',
    body: 'Steward the whole backlog.',
    standing: true,
    kill_criterion: null,
    tripwires: null,
    budget_cents: null,
    budget_window_sec: null,
    launch_settings: null,
    input_schema: null,
    output_schema: null,
    property_schema: null,
    inputs: null,
    metadata: { goalPackageRef: REF },
    ...overrides,
  };
}

function content(overrides: Partial<GoalPackageContent> = {}): GoalPackageContent {
  return {
    title: 'Work on everything',
    body: null,
    standing: true,
    killCriterion: null,
    tripwires: null,
    budgetCents: null,
    budgetWindowSec: null,
    launchSettings: null,
    inputSchema: null,
    outputSchema: null,
    propertySchema: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StartGoalFromPackageDeps> = {}) {
  const startById = vi.fn().mockResolvedValue({
    ok: true,
    goalId: 'x',
    ownerId: 'su-holder-1',
    warnings: [],
    startBlockedOverride: null,
  });
  const deps: StartGoalFromPackageDeps = {
    resolvePackage: vi.fn(() => pkg()),
    // P-022 defaults: a STATIC package (no construct.js); the runner mock
    // builds nothing so a test that never expects it can assert not-called.
    readConstructScript: vi.fn(() => null),
    runConstructor: vi.fn(async () => ({
      ok: true as const,
      spec: {},
      overriddenKeys: [] as string[],
    })),
    readInstances: vi.fn(async () => [] as Stub[]),
    adoptStub: vi.fn(async () => {}),
    restoreStub: vi.fn(async () => {}),
    mintRow: vi.fn(async () => {}),
    deleteRow: vi.fn(async () => {}),
    stampAgentOwner: vi.fn(async () => {}),
    startById: startById as unknown as StartGoalFromPackageDeps['startById'],
    drainEnabled: vi.fn(async () => false),
    mintDrain: vi.fn(async () => ({
      fleetSlug: 'goal-drain-x',
      created: true,
      specRevision: 1,
    })) as unknown as StartGoalFromPackageDeps['mintDrain'],
    ensurePropertyDatatypes: vi.fn(async () => {}),
    validatePropertySchema: vi.fn(async () => ({ ok: true as const })),
    buildBrief: vi.fn(() => 'KICKOFF BRIEF'),
    ...overrides,
  };
  return { deps, startById };
}

function run(deps: StartGoalFromPackageDeps, input: Partial<Parameters<typeof startGoalFromPackage>[1]> = {}) {
  return startGoalFromPackage(SQL, { workspaceId: WS, ref: REF, ...input }, deps);
}

describe('effectiveGoalContent — the standing-defaults fold (the P-022 seam)', () => {
  it('gives an undeclared standing package the respawn holder and the weekly window, disclosed', () => {
    const e = effectiveGoalContent(content({ budgetCents: 2500 }));
    expect(e.launchSettings.holder).toEqual(STANDING_GOAL_HOLDER_DEFAULT);
    expect(e.budgetWindowSec).toBe(STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC);
    expect(e.appliedDefaults).toHaveLength(2);
    expect(e.appliedDefaults.join('\n')).toContain("onLoss: 'respawn'");
    expect(e.appliedDefaults.join('\n')).toContain(String(STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC));
  });

  it('leaves a package-pinned holder policy alone', () => {
    const pinned = { requireLive: false, onLoss: 'deactivate' };
    const e = effectiveGoalContent(content({ launchSettings: { holder: pinned } }));
    expect(e.launchSettings.holder).toEqual(pinned);
    expect(e.appliedDefaults).toEqual([]);
  });

  it('gives a non-standing package requireLive only — and never the standing window', () => {
    const e = effectiveGoalContent(content({ standing: false, budgetCents: 2500 }));
    expect(e.launchSettings.holder).toEqual({ requireLive: true });
    expect(e.budgetWindowSec).toBeNull();
    expect(e.appliedDefaults).toHaveLength(1);
    expect(e.appliedDefaults[0]).toContain("onLoss: 'deactivate'");
  });

  it('keeps a window the package chose, and invents none for a package with no ceiling', () => {
    const chosen = effectiveGoalContent(content({ budgetCents: 2500, budgetWindowSec: 3600 }));
    expect(chosen.budgetWindowSec).toBe(3600);
    expect(chosen.appliedDefaults.some((d) => d.includes('budgetWindowSec'))).toBe(false);

    const noCeiling = effectiveGoalContent(content());
    expect(noCeiling.budgetWindowSec).toBeNull();
    expect(noCeiling.appliedDefaults.some((d) => d.includes('budgetWindowSec'))).toBe(false);
  });
});

describe('startGoalFromPackage — resolve + the P-021 inputs gate', () => {
  it('refuses an uninstalled package, reading and writing nothing', async () => {
    const { deps, startById } = makeDeps({ resolvePackage: vi.fn(() => null) });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'package-not-found' });
    expect(deps.readInstances).not.toHaveBeenCalled();
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(deps.mintRow).not.toHaveBeenCalled();
    expect(startById).not.toHaveBeenCalled();
  });

  it('refuses missing required inputs via the REAL gate, before adopt/mint — active instances still reported as info', async () => {
    const { deps, startById } = makeDeps({
      resolvePackage: vi.fn(() =>
        pkg({
          inputSchema: {
            type: 'object',
            required: ['tempo'],
            properties: { tempo: { type: 'string' } },
          },
        }),
      ),
      readInstances: vi.fn(async () => [
        stubRow({ id: 'work-on-everything-live01', status: 'active', metadata: { goalPackageRef: REF, agentOwnerId: 'su-live' } }),
      ]),
    });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: false, reason: 'inputs-not-ready' });
    expect(res.ok === false && res.detail).toContain('tempo');
    expect(res.ok === false && res.activeInstances).toHaveLength(1);
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(deps.mintRow).not.toHaveBeenCalled();
    expect(startById).not.toHaveBeenCalled();
  });
});

describe('startGoalFromPackage — adopt vs mint', () => {
  it('adopts the seeded stub: harness from its install_slug, pause cleared, startedBy stamped, brief threaded', async () => {
    const { deps, startById } = makeDeps({ readInstances: vi.fn(async () => [stubRow()]) });
    const res = await run(deps, { inputs: { tempo: 'daily' } });
    expect(res).toMatchObject({ ok: true, adopted: true, goalId: STUB_ID, ownerId: 'su-holder-1', drainFleet: null });
    expect(deps.adoptStub).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({
        workspaceId: WS,
        goalId: STUB_ID,
        inputs: { tempo: 'daily' },
        launchSettings: expect.objectContaining({ holder: STANDING_GOAL_HOLDER_DEFAULT }),
        metadata: { goalPackageRef: REF, startedBy: 'goals:start-from-package' },
      }),
    );
    expect(deps.mintRow).not.toHaveBeenCalled();
    expect(startById).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ workspaceId: WS, goalId: STUB_ID, kickoffPrompt: 'KICKOFF BRIEF' }),
    );
  });

  it('an active instance is INFO, never a gate — a fresh instance is minted beside it', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [
        stubRow({ id: 'work-on-everything-live01', status: 'active', metadata: { goalPackageRef: REF, agentOwnerId: 'su-live' } }),
      ]),
    });
    const res = await run(deps, { harness: 'papercusp', launcherOwnerId: 'su-me' });
    expect(res).toMatchObject({ ok: true, adopted: false });
    expect(res.ok && res.goalId).toMatch(/^work-on-everything-[0-9a-f]{6}$/);
    expect(res.ok && res.activeInstances).toEqual([
      expect.objectContaining({ id: 'work-on-everything-live01', status: 'active', adoptableStub: false }),
    ]);
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(deps.mintRow).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({
        workspaceId: WS,
        installSlug: 'papercusp',
        metadata: { goalPackageRef: REF, packageVersion: '1.2.0', startedFrom: 'package', startedBy: 'su-me' },
      }),
    );
  });

  it('inherits a packaged instance contract override when minting the next instance', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [
        stubRow({
          id: 'work-on-everything-live01',
          status: 'paused',
          metadata: {
            goalPackageRef: REF,
            agentOwnerId: 'su-old',
            packageInstanceOverride: {
              body: 'owner directive: keep this across instances',
            },
          },
        }),
      ]),
    });

    const res = await run(deps, { harness: 'papercusp', launcherOwnerId: 'su-me' });

    expect(res).toMatchObject({ ok: true, adopted: false });
    expect(deps.mintRow).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({
        content: expect.objectContaining({
          body: 'owner directive: keep this across instances',
        }),
        metadata: expect.objectContaining({
          packageInstanceOverride: {
            body: 'owner directive: keep this across instances',
          },
        }),
      }),
    );
  });

  it('a paused stub an agent was ever attached to is NOT adoptable — minting then requires harness', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [stubRow({ metadata: { goalPackageRef: REF, agentOwnerId: 'su-old' } })]),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'no-harness' });
    expect(res.ok === false && res.detail).toContain('no unstarted stub');
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(deps.mintRow).not.toHaveBeenCalled();
  });

  it('refuses a stub with no install_slug rather than guessing a harness', async () => {
    const { deps } = makeDeps({ readInstances: vi.fn(async () => [stubRow({ install_slug: null })]) });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'no-harness' });
    expect(res.ok === false && res.detail).toContain('re-seed');
    expect(deps.adoptStub).not.toHaveBeenCalled();
  });
});

describe('startGoalFromPackage — typed property declarations (P-025)', () => {
  const DECL = { worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both' } };

  it('mint ensures the datatypes, validates the declaration, and threads it to the minted row', async () => {
    const { deps } = makeDeps({ resolvePackage: vi.fn(() => pkg({ propertySchema: DECL })) });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: true, adopted: false });
    expect(deps.ensurePropertyDatatypes).toHaveBeenCalledWith(SQL, { workspaceId: WS });
    expect(deps.validatePropertySchema).toHaveBeenCalledWith(SQL, { workspaceId: WS, doc: DECL });
    expect(deps.mintRow).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ content: expect.objectContaining({ propertySchema: DECL }) }),
    );
  });

  it('refuses the mint when the declaration cannot bind — nothing written, nothing started', async () => {
    const { deps, startById } = makeDeps({
      resolvePackage: vi.fn(() => pkg({ propertySchema: DECL })),
      validatePropertySchema: vi.fn(async () => ({
        ok: false as const,
        issues: ["worklist: unknown datatype 'plan-ref-list'"],
      })),
    });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: false, reason: 'property-schema-invalid' });
    expect(res.ok === false && res.detail).toContain('unknown datatype');
    expect(deps.mintRow).not.toHaveBeenCalled();
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(startById).not.toHaveBeenCalled();
  });

  it('adopt maps the stub row property_schema and never re-validates (seed-time already did)', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [stubRow({ property_schema: DECL })]),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, adopted: true });
    expect(deps.ensurePropertyDatatypes).not.toHaveBeenCalled();
    expect(deps.validatePropertySchema).not.toHaveBeenCalled();
  });

  it('a package with no declaration skips the gate entirely', async () => {
    const { deps } = makeDeps();
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: true });
    expect(deps.ensurePropertyDatatypes).not.toHaveBeenCalled();
    expect(deps.validatePropertySchema).not.toHaveBeenCalled();
  });
});

describe('startGoalFromPackage — the brief is built from the EFFECTIVE content', () => {
  it('threads standing polarity and the folded window into buildBrief, and its output into the primitive', async () => {
    const { deps, startById } = makeDeps({
      resolvePackage: vi.fn(() => pkg({ budgetCents: 2500, body: 'B' })),
    });
    await run(deps, { harness: 'papercusp' });
    expect(deps.buildBrief).toHaveBeenCalledWith({
      goalId: expect.stringMatching(/^work-on-everything-/),
      title: 'Work on everything',
      killCriterion: null,
      budgetCents: 2500,
      body: 'B',
      standing: true,
      budgetWindowSec: STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC,
    });
    expect(startById).toHaveBeenCalledWith(SQL, expect.objectContaining({ kickoffPrompt: 'KICKOFF BRIEF' }));
  });
});

describe('startGoalFromPackage — compensation (refusal ≠ throw)', () => {
  it('rolls back a minted instance when the primitive refuses', async () => {
    const { deps, startById } = makeDeps();
    startById.mockResolvedValue({ ok: false, reason: 'not-ready', detail: 'blocked on plan X' });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(res.ok === false && res.detail).toContain('rolled back');
    expect(deps.deleteRow).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ workspaceId: WS, id: expect.stringMatching(/^work-on-everything-/) }),
    );
    expect(deps.restoreStub).not.toHaveBeenCalled();
  });

  it('restores the adopted stub to its installed state when the primitive refuses', async () => {
    const { deps, startById } = makeDeps({ readInstances: vi.fn(async () => [stubRow()]) });
    startById.mockResolvedValue({ ok: false, reason: 'not-active', detail: 'status flipped underneath' });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'not-active' });
    expect(res.ok === false && res.detail).toContain('restored to its installed state');
    expect(deps.restoreStub).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ workspaceId: WS, stub: expect.objectContaining({ id: STUB_ID, status: 'paused' }) }),
    );
    expect(deps.deleteRow).not.toHaveBeenCalled();
  });

  it.each(['already-held', 'holder-unknown'] as const)(
    "leaves the minted instance in place on '%s' — a holder may exist",
    async (reason) => {
      const { deps, startById } = makeDeps();
      startById.mockResolvedValue({ ok: false, reason, detail: 'holder evidence' });
      const res = await run(deps, { harness: 'papercusp' });
      expect(res).toMatchObject({ ok: false, reason });
      expect(res.ok === false && res.detail).toContain('left in place');
      expect(deps.deleteRow).not.toHaveBeenCalled();
      expect(deps.restoreStub).not.toHaveBeenCalled();
    },
  );

  it("leaves the adopted stub active on 'already-held'", async () => {
    const { deps, startById } = makeDeps({ readInstances: vi.fn(async () => [stubRow()]) });
    startById.mockResolvedValue({ ok: false, reason: 'already-held', detail: 'live holder su-x' });
    const res = await run(deps);
    expect(res.ok === false && res.detail).toContain('left active');
    expect(deps.restoreStub).not.toHaveBeenCalled();
    expect(deps.deleteRow).not.toHaveBeenCalled();
  });

  it('a THROW from the primitive propagates with NO compensation — the spawn already happened', async () => {
    const { deps, startById } = makeDeps({ readInstances: vi.fn(async () => [stubRow()]) });
    startById.mockRejectedValue(new Error('spawn exploded'));
    await expect(run(deps)).rejects.toThrow('spawn exploded');
    expect(deps.deleteRow).not.toHaveBeenCalled();
    expect(deps.restoreStub).not.toHaveBeenCalled();
  });
});

describe('startGoalFromPackage — post-start stamps are fail-soft', () => {
  it('stamps the owning agent; a stamp failure becomes a warning, never a refusal', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [stubRow()]),
      stampAgentOwner: vi.fn(async () => {
        throw new Error('stamp db down');
      }),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.warnings.some((w) => w.includes('agentOwnerId stamp failed: stamp db down'))).toBe(true);
  });

  it('mints the drain fleet when the flag is on, naming it in the result + warning', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [stubRow()]),
      drainEnabled: vi.fn(async () => true),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, drainFleet: 'goal-drain-x' });
    expect(deps.mintDrain).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, harnessSlug: 'papercusp', goalId: STUB_ID, goalTitle: 'Work on everything', agentOwnerId: 'su-holder-1' }),
    );
    expect(res.ok && res.warnings.some((w) => w.includes("drain fleet 'goal-drain-x' minted"))).toBe(true);
    expect(deps.stampAgentOwner).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ goalId: STUB_ID, ownerId: 'su-holder-1' }),
    );
  });

  // EI-24556293106348130: this door mints the fleet rows and the watchdog then
  // launches leader + worker under these ceilings; below the floor the worker is
  // refused every time. Refuse before anything is adopted, minted, or started.
  it('refuses a package whose ceilings cannot hold the drain worker', async () => {
    // Mint path (no stub): the PACKAGE's settings are the effective ones.
    const { deps, startById } = makeDeps({
      resolvePackage: vi.fn(() => pkg({ launchSettings: { maxAgents: 2, maxPerFleet: 1 } })),
      drainEnabled: vi.fn(async () => true),
    });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: false, reason: 'launch-ceilings-too-low' });
    expect(!res.ok && res.detail).toContain('maxAgents=2');
    expect(startById).not.toHaveBeenCalled();
    expect(deps.mintRow).not.toHaveBeenCalled();
    expect(deps.mintDrain).not.toHaveBeenCalled();
  });

  it('does not apply the drain floor when no drain fleet will be minted', async () => {
    const { deps } = makeDeps({
      resolvePackage: vi.fn(() => pkg({ launchSettings: { maxAgents: 2, maxPerFleet: 1 } })),
      drainEnabled: vi.fn(async () => false),
    });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: true, drainFleet: null });
  });

  it('a drain-mint failure is a warning on a still-successful start', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [stubRow()]),
      drainEnabled: vi.fn(async () => true),
      mintDrain: vi.fn(async () => {
        throw new Error('fleet registry down');
      }) as unknown as StartGoalFromPackageDeps['mintDrain'],
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, drainFleet: null });
    expect(res.ok && res.warnings.some((w) => w.includes('drain-fleet auto-mint failed'))).toBe(true);
  });
});

describe('startGoalFromPackage — the P-022 constructor wiring', () => {
  const SCRIPT = 'return { title: "Built title", budgetCents: 500 };';
  const CONSTRUCT_DECL = { version: 1, properties: { focus: { datatype: 'string', editable_by: 'owner' } } };

  it('merges the constructed spec over static content and stamps + discloses the keys (mint path)', async () => {
    const { deps } = makeDeps({
      readConstructScript: vi.fn(() => SCRIPT),
      runConstructor: vi.fn(async () => ({
        ok: true as const,
        spec: { title: 'Built title', budgetCents: 500 },
        overriddenKeys: ['budgetCents', 'title'],
      })),
    });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: true, adopted: false, constructedKeys: ['budgetCents', 'title'] });
    expect(vi.mocked(deps.runConstructor).mock.calls[0][0]).toBe(SCRIPT);
    const mint = vi.mocked(deps.mintRow).mock.calls[0][1];
    expect(mint.content.title).toBe('Built title');
    expect(mint.content.budgetCents).toBe(500);
    // unspecified fields fall through from the static package
    expect(mint.content.body).toBe('Steward the whole backlog.');
    expect(mint.metadata.packageConstructedKeys).toEqual(['budgetCents', 'title']);
  });

  it('surfaces a constructor refusal verbatim — nothing minted, adopted, or started', async () => {
    const { deps, startById } = makeDeps({
      readConstructScript: vi.fn(() => 'return { title: Math.random() };'),
      runConstructor: vi.fn(async () => ({
        ok: false as const,
        reason: 'construct-nondeterministic' as const,
        detail: 'two runs over identical inputs produced different specs',
      })),
    });
    const res = await run(deps, { harness: 'papercusp' });
    expect(res).toMatchObject({ ok: false, reason: 'construct-nondeterministic' });
    expect(deps.mintRow).not.toHaveBeenCalled();
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(startById).not.toHaveBeenCalled();
  });

  it('never runs the constructor for a static package, and discloses no constructed keys', async () => {
    const { deps } = makeDeps({ readInstances: vi.fn(async () => [stubRow()]) });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, constructedKeys: [] });
    expect(deps.runConstructor).not.toHaveBeenCalled();
    const adopt = vi.mocked(deps.adoptStub).mock.calls[0][1];
    expect(adopt.constructedContent).toBeNull();
    expect(adopt.metadata.packageConstructedKeys).toBeUndefined();
  });

  it('adopt path: rewrites the stub content and validates a CONSTRUCTED propertySchema', async () => {
    const { deps } = makeDeps({
      readInstances: vi.fn(async () => [stubRow()]),
      readConstructScript: vi.fn(() => SCRIPT),
      runConstructor: vi.fn(async () => ({
        ok: true as const,
        spec: { title: 'Built title', propertySchema: CONSTRUCT_DECL },
        overriddenKeys: ['propertySchema', 'title'],
      })),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, adopted: true, constructedKeys: ['propertySchema', 'title'] });
    // A constructed declaration never saw the install-seed gate — it validates
    // here even on the adopt path (a static stub's declaration does not).
    expect(deps.validatePropertySchema).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ doc: CONSTRUCT_DECL }),
    );
    const adopt = vi.mocked(deps.adoptStub).mock.calls[0][1];
    expect(adopt.constructedContent?.title).toBe('Built title');
    expect(adopt.constructedContent?.propertySchema).toEqual(CONSTRUCT_DECL);
    expect(adopt.metadata.packageConstructedKeys).toEqual(['propertySchema', 'title']);
  });

  it('a constructed-invalid propertySchema refuses the adopt before any write', async () => {
    const { deps, startById } = makeDeps({
      readInstances: vi.fn(async () => [stubRow()]),
      readConstructScript: vi.fn(() => SCRIPT),
      runConstructor: vi.fn(async () => ({
        ok: true as const,
        spec: { propertySchema: CONSTRUCT_DECL },
        overriddenKeys: ['propertySchema'],
      })),
      validatePropertySchema: vi.fn(async () => ({ ok: false as const, issues: ['unknown datatype'] })),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'property-schema-invalid' });
    expect(deps.adoptStub).not.toHaveBeenCalled();
    expect(startById).not.toHaveBeenCalled();
  });
});
