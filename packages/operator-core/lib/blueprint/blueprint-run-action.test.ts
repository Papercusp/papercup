import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadBuiltinBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { getSystemAction, listSystemActions, type SystemActionCtx, type SystemActionResult } from '../harness/routines/system-actions';

// P-009: the decider fire consults the autoloop fire gate + records outcomes.
// Mock the gate controllably (default: allow) so unit tests never touch PG.
const gateState = vi.hoisted(() => ({
  verdict: { allow: true, consecutiveErrors: 0 } as Record<string, unknown>,
}));
vi.mock('../autoloop', () => ({
  checkFireGate: vi.fn(async () => gateState.verdict),
  recordFire: vi.fn(async () => {}),
}));

import {
  handleBlueprintRun,
  setBlueprintResolver,
  setBlueprintRunFire,
  type DeciderFireFn,
} from './blueprint-run-action';
import { setLaunchBlueprintFire, type LaunchFireFn } from './launch-blueprint';
import { setNegativeSpaceScanDeps } from '../blueprint-steps/ops/negative-space-scan';

const coding = loadBuiltinBlueprint('coding-factory').blueprint;
const withDecider = (role: string): Blueprint => ({ ...coding, spine: { ...coding.spine, decider: role } });

const ctx = (over: Partial<SystemActionCtx> = {}): SystemActionCtx => ({
  installSlug: 'demo',
  workspaceId: 'ws_test',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});

afterEach(() => {
  setBlueprintResolver(null);
  setBlueprintRunFire(null);
  setLaunchBlueprintFire(null);
  setNegativeSpaceScanDeps(null);
  gateState.verdict = { allow: true, consecutiveErrors: 0 };
});

describe('system:blueprint-run handler (P-021 / D-018)', () => {
  it('is registered into the system-action registry under "blueprint-run"', () => {
    // Importing the module (above) ran registerSystemAction — this is the exact fn
    // routinesTick's routineFireImpl dispatches a `system:blueprint-run` routine to.
    expect(getSystemAction('blueprint-run')).toBe(handleBlueprintRun);
    expect(listSystemActions()).toContain('blueprint-run');
  });

  it("mode='run' (default) fires the blueprint's declared decider", async () => {
    const fired: Array<Parameters<DeciderFireFn>[0]> = [];
    setBlueprintResolver(async () => withDecider('auditor'));
    setBlueprintRunFire((input) => { fired.push(input); });

    await handleBlueprintRun(ctx()); // no mode → default 'run'

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ installSlug: 'demo', workspaceId: 'ws_test', role: 'auditor' });
    expect(fired[0].kickoff).toContain('demo');
  });

  it("mode='run' falls back to the coding decider ('director') when no blueprint resolves", async () => {
    const fired: Array<Parameters<DeciderFireFn>[0]> = [];
    setBlueprintResolver(async () => null); // harness has no blueprint → coding fallback
    setBlueprintRunFire((input) => { fired.push(input); });

    await handleBlueprintRun(ctx({ payloadTemplate: { mode: 'run' } }));

    expect(fired).toHaveLength(1);
    expect(fired[0].role).toBe('director'); // built-in coding spine.decider
  });

  it("mode='run' WITHHOLDS the fire when the backoff gate denies (P-009 / D-009)", async () => {
    const fired: Array<Parameters<DeciderFireFn>[0]> = [];
    setBlueprintResolver(async () => withDecider('director'));
    setBlueprintRunFire((input) => { fired.push(input); });
    gateState.verdict = { allow: false, reason: 'circuit-open', consecutiveErrors: 9, retryAfterSec: 1200 };
    // The withhold logs a console.warn by design — assert it, mocked.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleBlueprintRun(ctx());

    expect(fired).toHaveLength(0); // no fire while the circuit is open
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/WITHHELD.*circuit-open/);
    warn.mockRestore();
  });

  it("payload.blueprintId QUEUES a durable launch of that STANDALONE blueprint's role (unify-launches D-002, EI-995)", async () => {
    // The `scan` cadence routine seeds `{ blueprintId: 'scan' }`. The handler runs
    // INSIDE a DBOS step, so it must NOT fire inline (startWorkflow-from-step is
    // rejected → the EI-995 Queen/Overwatch no-op). It RETURNS the launch as a
    // durableSpawn for the routine workflow to start AFTER the step. Role resolves
    // from the NAMED launch blueprint, NOT the harness's effective blueprint.
    setBlueprintResolver(async () => {
      throw new Error('harness-effective resolver should not run for a named launch blueprint');
    });

    const result = (await handleBlueprintRun(
      ctx({ payloadTemplate: { blueprintId: 'scan', kickoff: 'sweep now' } }),
    )) as SystemActionResult | undefined;

    expect(result?.durableSpawns).toHaveLength(1);
    const spawn = result!.durableSpawns![0];
    expect(spawn.spawnRecord?.childRole).toBe('scanner'); // role resolved from the 'scan' blueprint
    expect(spawn.label).toBe('demo/scanner');
    expect(spawn.body.kickoff).toBe('sweep now');
    expect(spawn.body.extra).toContain('BLUEPRINT_ID=scan');
  });

  it('payload.timeoutMs threads through to the durable launch body (a scan needs >> the 90s route default)', async () => {
    const result = (await handleBlueprintRun(
      ctx({ payloadTemplate: { blueprintId: 'scan', kickoff: 'sweep now', timeoutMs: 900_000 } }),
    )) as SystemActionResult | undefined;

    expect(result?.durableSpawns).toHaveLength(1);
    const spawn = result!.durableSpawns![0];
    expect(spawn.spawnRecord?.childRole).toBe('scanner');
    expect(spawn.body.timeoutMs).toBe(900_000);
  });

  it('a missing/garbage payload.timeoutMs is omitted from the durable launch body (route default applies)', async () => {
    const result = (await handleBlueprintRun(
      ctx({ payloadTemplate: { blueprintId: 'scan', kickoff: 'sweep', timeoutMs: 'soon' } }),
    )) as SystemActionResult | undefined;

    expect(result?.durableSpawns).toHaveLength(1);
    expect(result!.durableSpawns![0].body.timeoutMs).toBeUndefined();
  });

  it('payload.blueprintId for a PROGRAM-mode blueprint runs its deterministic program inline (P-011)', async () => {
    // deterministic-blueprints-migration P-011: a migrated loop's routine seeds
    // `{ blueprintId: 'negative-space' }`. The handler must detect program-mode and
    // run the steps+gate program inline (the deterministic `negative-space:scan`
    // step) — NOT fire a decider. The op's own seam keeps the miner off PG.
    let ranTick = false;
    setNegativeSpaceScanDeps({
      flag: async () => true,
      governorGate: async () => ({ allow: true, remainingUsd: 0 }),
      tickDeps: {
        readRows: async () => {
          ranTick = true;
          return [];
        },
        persist: async (_ws, entries) => entries,
        capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
        markFiled: async () => {},
        log: () => {},
      },
    });
    const launchFired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      launchFired.push(input);
    });

    await handleBlueprintRun(ctx({ payloadTemplate: { blueprintId: 'negative-space' } }));

    expect(ranTick).toBe(true); // the deterministic step ran the miner tick inline
    expect(launchFired).toHaveLength(0); // a program blueprint never fires a decider/launch
  });

  // mode='work-item' touches getOrgPg().sql (the work_items base insert), so it is covered
  // by blueprint-run-action.integration.test.ts against a throwaway DB — exercising it here
  // would write to whatever PG getOrgPg() resolves to. This unit file stays hermetic: it
  // only drives the injected resolver + fire seams (no DB).
});
