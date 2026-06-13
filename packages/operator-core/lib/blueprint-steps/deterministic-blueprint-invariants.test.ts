/**
 * deterministic-blueprint-invariants.test.ts — P-140 of
 * deterministic-blueprints-migration-2026-06-13 (Phase 5, safety + verification).
 *
 * The four safety invariants of the deterministic-step kind + the migration,
 * pinned in one place so a refactor of the executor / validator / migrated loops
 * cannot silently un-make them:
 *
 *   1. A deterministic step cannot exceed its DECLARED I/O — the executor parses
 *      a step's args against the op's `argsSchema` before `run` (extra args
 *      stripped, wrong-typed args rejected), and every deterministic step-op
 *      declares both an `argsSchema` AND a `resultSchema`, whose declared output
 *      shape the op's real result is within.
 *   2. The VALIDATOR accepts deterministic + hybrid spines — a gateless
 *      deterministic pipeline, a hybrid (deterministic + agent `spawn-roles`
 *      step), and a hybrid with a decision gate all validate; an unknown op and a
 *      gate with no fallback are rejected.
 *   3. A migrated loop's AGENT SPAWNS are confinement-routed — a hybrid spine's
 *      agent leg goes through `orchestrator:spawn-roles` → `ctx.caps.spawnRoles`
 *      (which in prod is `coordSpawnRunner` → `spawnInvokeOnce`, the ONE governed
 *      launch chokepoint), carrying the owning blueprint's id; there is no second
 *      spawn path.
 *   4. BEHAVIOR-NEUTRAL migration (D-004) — a migrated loop's deterministic step
 *      wraps the SAME shipped core (`runNegativeSpaceMine`) the bespoke routine
 *      ran: the flag gate, the governor (budget) gate, and the output all carry
 *      through identically; the cadence routine fires the blueprint at the same
 *      cron, not the retired bespoke action.
 *
 * Per-loop behavior lives in the colocated suites (negative-space-blueprint.test.ts
 * etc.); validator program-spine mechanics in validate-program.test.ts; this suite
 * pins the cross-cutting invariant arcs those don't compose.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  loadBuiltinBlueprint,
  validateBlueprint,
  type Blueprint,
} from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js'; // register the coordination ops (resolve, spawn-roles, …)
import './index.js'; // register the deterministic step-ops (negative-space:scan, …)
import { coordOpNames, requireCoordOp, registerCoordOp } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { negativeSpaceScanOp, setNegativeSpaceScanDeps } from './ops/negative-space-scan.js';
import type { CoordOp } from '../coord-ops/types.js';
import type { NegativeSpaceTickDeps } from '../negative-space/scan.js';

/** The deterministic step-ops registered by ./index.js (the migrated loops). */
const DETERMINISTIC_STEP_OPS = ['negative-space:scan', 'regret:mine', 'neologism:mine', 'fleet-ekg:scan'];

/** Tick deps that never touch PG — a clean empty mine (from negative-space-blueprint.test.ts). */
function fakeTickDeps(): NegativeSpaceTickDeps {
  return {
    readRows: async () => [],
    persist: async (_ws, entries) => entries,
    capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
    markFiled: async () => {},
    log: () => {},
  };
}

/** Clone the builtin negative-space blueprint and replace its spine steps/gate. */
function withSpine(
  base: Blueprint,
  id: string,
  steps: Blueprint['spine']['steps'],
  gate?: Blueprint['spine']['gate'],
): Blueprint {
  return { ...base, id, spine: { ...base.spine, steps, gate } };
}

afterEach(() => setNegativeSpaceScanDeps(null));

// ── 1. a deterministic step cannot exceed its declared I/O ───────────────────

describe('P-140.1 — a deterministic step cannot exceed its declared I/O', () => {
  // A registered probe op: declares a tight arg/result schema; records what it saw.
  let lastSeenArgs: unknown = null;
  const ioProbeOp: CoordOp<{ a: number }, { echoed: number }> = {
    name: 'test:io-probe',
    description: 'declared-I/O probe (P-140)',
    argsSchema: z.object({ a: z.number() }),
    resultSchema: z.object({ echoed: z.number() }),
    async run(args) {
      lastSeenArgs = args;
      return { echoed: args.a };
    },
  };
  registerCoordOp(ioProbeOp);

  it('the executor STRIPS args beyond the declared argsSchema — the op only ever sees its declared input', async () => {
    const { caps } = makeFakeCaps();
    const ctx = makeCtx(caps);
    await inlineRunOp({ op: 'test:io-probe', args: { a: 1, sneaky: 'x', extra: 99 }, label: 'op-probe' }, ctx);
    expect(lastSeenArgs).toEqual({ a: 1 }); // sneaky / extra never reached run
  });

  it('the executor REJECTS a wrong-typed arg before run — a step cannot smuggle an off-schema input', async () => {
    const { caps } = makeFakeCaps();
    const ctx = makeCtx(caps);
    await expect(
      inlineRunOp({ op: 'test:io-probe', args: { a: 'not-a-number' }, label: 'op-bad' }, ctx),
    ).rejects.toThrow();
  });

  it('every deterministic step-op DECLARES both an argsSchema and a resultSchema (its I/O contract exists)', () => {
    for (const name of DETERMINISTIC_STEP_OPS) {
      const op = requireCoordOp(name);
      expect(typeof op.argsSchema?.parse).toBe('function');
      expect(typeof op.resultSchema?.parse).toBe('function');
    }
  });

  it("a deterministic step's real output is WITHIN its declared resultSchema (no undeclared output keys)", async () => {
    setNegativeSpaceScanDeps({ flag: async () => false }); // flag-off → no PG, a clean known result
    const { caps } = makeFakeCaps();
    const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
    const result = await negativeSpaceScanOp.run({}, ctx);
    // resultSchema.parse drops UNDECLARED keys; equality after parse ⇒ the op
    // emitted nothing beyond its declared output I/O.
    expect(negativeSpaceScanOp.resultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ ran: false, skipReason: 'flag-off' });
  });
});

// ── 2. the validator accepts deterministic + hybrid spines ───────────────────

describe('P-140.2 — the validator accepts deterministic + hybrid spines (rejects malformed ones)', () => {
  const knownOps = () => coordOpNames();
  const base = () => loadBuiltinBlueprint('negative-space').blueprint;

  const detStep = { id: 'scan', op: 'negative-space:scan', args: {}, bind: 'scan' };
  const agentStep = {
    id: 'fan-out',
    op: 'orchestrator:spawn-roles',
    args: { conversation_id: 'conv-x', roles: [{ role: 'voter', count: 2 }], inject: {}, max_voters: 5 },
    bind: 'fan',
  };

  it('a gateless DETERMINISTIC pipeline (a single deterministic step) validates', () => {
    const v = validateBlueprint(withSpine(base(), 'det-only', [detStep]), { knownOps: knownOps() });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('a HYBRID spine (deterministic step + an agent spawn-roles step, no gate) validates', () => {
    const v = validateBlueprint(withSpine(base(), 'hybrid', [detStep, agentStep]), { knownOps: knownOps() });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('a HYBRID spine with a decision gate (det + agent steps, gate with a fallback) validates', () => {
    const gate = [{ else: true, op: 'resolve', args: {} }];
    const v = validateBlueprint(withSpine(base(), 'hybrid-gated', [detStep, agentStep], gate), {
      knownOps: knownOps(),
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('an UNKNOWN op is rejected (the validator gates on the registered op set)', () => {
    const v = validateBlueprint(withSpine(base(), 'bad-op', [{ id: 's', op: 'bogus:nope', args: {} }]), {
      knownOps: knownOps(),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code)).toContain('unknown-op');
  });

  it('a decision gate with NO fallback branch is rejected (some scope would never resolve)', () => {
    const gate = [{ when: { 'scan.ran': { truthy: true } }, op: 'resolve', args: {} }];
    const v = validateBlueprint(withSpine(base(), 'no-fallback', [detStep], gate), { knownOps: knownOps() });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code)).toContain('gate-no-fallback');
  });
});

// ── 3. a migrated loop's agent spawns are confinement-routed ─────────────────

describe('P-140.3 — a hybrid loop’s agent spawn rides the one governed launch chokepoint (caps.spawnRoles)', () => {
  it('the agent step routes through ctx.caps.spawnRoles (NOT a raw spawn), carrying the owning blueprint id', async () => {
    setNegativeSpaceScanDeps({ flag: async () => false }); // the det step no-ops; we exercise the agent leg
    const base = loadBuiltinBlueprint('negative-space').blueprint;
    const hybrid = withSpine(base, 'hybrid-run', [
      { id: 'scan', op: 'negative-space:scan', args: {}, bind: 'scan' },
      {
        id: 'fan-out',
        op: 'orchestrator:spawn-roles',
        args: { conversation_id: 'conv-x', roles: [{ role: 'voter', count: 2 }], inject: {}, max_voters: 5 },
        bind: 'fan',
      },
    ]);
    const { caps, calls } = makeFakeCaps();
    const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });

    const out = await runProgramCore({ blueprint: hybrid, payload: {}, ctx, runOp: inlineRunOp });
    expect(out.outcome).toBe('done'); // gateless hybrid runs to completion

    // The agent leg went through the ONE spawn seam — in prod caps.spawnRoles is
    // coordSpawnRunner → spawnInvokeOnce (the governed + confined launch chokepoint).
    expect(calls.spawnRoles.length).toBe(1);
    const specs = calls.spawnRoles[0];
    expect(specs.map((s) => s.role)).toEqual(['voter', 'voter']);
    // Every spawned spec carries the OWNING blueprint id (stamped by runProgramCore)
    // — the confinement context that resolves the role's prompt + scopes the spawn.
    for (const s of specs) expect(s.blueprintId).toBe('hybrid-run');
  });

  it('orchestrator:spawn-roles is THE registered agent-dispatch op — there is no second program spawn path', () => {
    // The program executor dispatches agents only via this op; the op's run hands
    // the resolved specs to ctx.caps.spawnRoles (the chokepoint), never a raw child.
    const op = requireCoordOp('orchestrator:spawn-roles');
    expect(op.name).toBe('orchestrator:spawn-roles');
    const src = readFileSync(new URL('../coord-ops/ops/spawn-roles.ts', import.meta.url), 'utf8');
    expect(src).toContain('ctx.caps.spawnRoles(');
    expect(src).not.toMatch(/child_process|spawnInvokeOnce\(|buildInvokeOnce\(/);
  });
});

// ── 4. behavior-neutral migration (D-004) ────────────────────────────────────

describe('P-140.4 — behavior-neutral migration: same core, same flag/governor gates, same cadence', () => {
  it('flag OFF → the deterministic step no-ops (dark stays dark) — identical to the bespoke action', async () => {
    setNegativeSpaceScanDeps({ flag: async () => false });
    const ctx = makeCtx(makeFakeCaps().caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
    const r = await negativeSpaceScanOp.run({}, ctx);
    expect(r).toMatchObject({ ran: false, skipReason: 'flag-off' });
  });

  it('governor REFUSAL → the deterministic step no-ops (the budget rail carries through, D-004)', async () => {
    setNegativeSpaceScanDeps({
      flag: async () => true,
      governorGate: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
    });
    const ctx = makeCtx(makeFakeCaps().caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
    const r = await negativeSpaceScanOp.run({}, ctx);
    expect(r).toMatchObject({ ran: false, skipReason: 'governor-refused', governorReason: 'unbudgeted' });
  });

  it('flag ON + governor ALLOW → the step runs the SAME shipped core and projects its outcome as the typed result', async () => {
    setNegativeSpaceScanDeps({
      flag: async () => true,
      governorGate: async () => ({ allow: true, remainingUsd: 0 }),
      tickDeps: fakeTickDeps(),
    });
    const ctx = makeCtx(makeFakeCaps().caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
    const r = await negativeSpaceScanOp.run({}, ctx);
    // The core ran over an empty mine; the op surfaces the core outcome unchanged.
    expect(r).toMatchObject({ ran: true, scanned: 0 });
  });

  it('the cadence is behavior-neutral: the seed routine fires the blueprint at the same cron, NOT the retired bespoke action', () => {
    const seed = readFileSync(
      new URL('../negative-space/seed-negative-space-routine.ts', import.meta.url),
      'utf8',
    );
    expect(seed).toContain("target: 'system:blueprint-run'"); // the generic program runner
    expect(seed).toContain("blueprintId: 'negative-space'"); // … fires the migrated blueprint
    expect(seed).toContain("cron: '0 25 */6 * * *'"); // … at the unchanged 6h cadence
    // and never the retired bespoke action as a TARGET (two-execution-model regression)
    expect(seed).not.toMatch(/target:\s*'system:negative-space-mine'/);
  });
});
