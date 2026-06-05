import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadBuiltinBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { getSystemAction, listSystemActions, type SystemActionCtx } from '../harness/routines/system-actions';

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

const coding = loadBuiltinBlueprint('coding').blueprint;
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

  it("payload.blueprintId fires that STANDALONE launch blueprint's role (unify-launches D-002)", async () => {
    // The `scan` cadence routine seeds `{ blueprintId: 'scan' }`; the handler must
    // fire the NAMED launch blueprint via the launch-blueprint primitive (role
    // resolves from the blueprint), NOT the harness's effective blueprint.
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // The harness-effective resolver must NOT be consulted on the blueprintId path.
    setBlueprintResolver(async () => {
      throw new Error('harness-effective resolver should not run for a named launch blueprint');
    });

    await handleBlueprintRun(ctx({ payloadTemplate: { blueprintId: 'scan', kickoff: 'sweep now' } }));

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'scan', role: 'scanner', kickoff: 'sweep now' });
  });

  it('payload.timeoutMs threads through to the launch fire (a scan needs >> the 90s route default)', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });

    await handleBlueprintRun(
      ctx({ payloadTemplate: { blueprintId: 'scan', kickoff: 'sweep now', timeoutMs: 900_000 } }),
    );

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'scan', role: 'scanner', timeoutMs: 900_000 });
  });

  it('a missing/garbage payload.timeoutMs is omitted from the fire (route default applies)', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });

    await handleBlueprintRun(
      ctx({ payloadTemplate: { blueprintId: 'scan', kickoff: 'sweep', timeoutMs: 'soon' } }),
    );

    expect(fired).toHaveLength(1);
    expect(fired[0].timeoutMs).toBeUndefined();
  });

  // mode='work-item' touches getOrgPg().sql (the work_items base insert), so it is covered
  // by blueprint-run-action.integration.test.ts against a throwaway DB — exercising it here
  // would write to whatever PG getOrgPg() resolves to. This unit file stays hermetic: it
  // only drives the injected resolver + fire seams (no DB).
});
