/**
 * EI-22174225494240206 — the host half of the ambient-dispatch-arg-keys seam.
 * `ambient-args-wiring.ts` registers Papercusp's own dispatch-level reserved args
 * (`projection`, `view`) with tooldef's resolver as a side effect of import (see
 * `agent-tools/index.ts`), the same shape as `server-vintage-wiring.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readAmbientArgKeys, resetAmbientArgKeysResolver } from '@papercusp/agent-mcp';
import { PROJECTION_ARG, VIEW_ARG } from '../result-projection';
import { runWithoutAmbientArgPeeling } from './ambient-args-scope';
import { bindCurrentCallerDispatch } from './orchestration/current-caller-dispatch';
import './ambient-args-wiring';

// The wiring under test registers the resolver as an IMPORT-TIME side effect (once,
// above) — not per-test — so reset only after the whole file's assertions are done,
// not between them (an afterEach here would clear it before the second test ever runs).
afterAll(() => resetAmbientArgKeysResolver());

describe('ambient-args Papercusp wiring', () => {
  it('registers both dispatch-level reserved args', () => {
    expect(readAmbientArgKeys()).toEqual([PROJECTION_ARG, VIEW_ARG]);
  });

  it('reads them from the SAME exported constants the transport strips with, not re-typed literals', () => {
    // A literal re-typed copy would still equal 'projection'/'view' today but would
    // silently drift the moment either constant is renamed (derived-truth-ladder
    // rung 1) — assert identity with the source constants, not their current values.
    const keys = readAmbientArgKeys();
    expect(keys).toContain(PROJECTION_ARG);
    expect(keys).toContain(VIEW_ARG);
  });
});

/**
 * EI-22295290349236847 — the resolver's answer is PER-DISPATCH, not process-wide.
 *
 * Only `_mcp-handler.ts` strips `projection`/`view`; a dispatch beneath that transport
 * (`runToolOrchestration`, what a `code:run`/`recipes:run` script calls) peels neither,
 * so naming them there tells a caller a key is accepted on a path that rejects it.
 */
describe('ambient-args are reported per-dispatch, not process-wide', () => {
  it('reports NO ambient keys inside a dispatch that peels none', () => {
    expect(runWithoutAmbientArgPeeling(() => readAmbientArgKeys())).toEqual([]);
  });

  it('still reports both on the transport path once the scope exits', () => {
    runWithoutAmbientArgPeeling(() => readAmbientArgKeys());
    // The suppression must not leak past its own dispatch — otherwise the FIRST
    // orchestration call in a process would silently disarm the hint for every
    // later transport call, which is the original EI-22174225494240206 regression.
    expect(readAmbientArgKeys()).toEqual([PROJECTION_ARG, VIEW_ARG]);
  });

  // The funnel contract: `bindCurrentCallerDispatch` is what `code:run` and
  // `recipes:run` both pass every nested call through, so it is where the scope has to
  // be established. Asserting on the helper alone would leave the wiring unproven —
  // exactly the gap that lets a fix exist and never reach the path that needed it.
  it('bindCurrentCallerDispatch establishes the scope around the real dispatch', async () => {
    // Reuse-an-outer-transaction path: needs no database, no principal synthesis and no
    // workspace ALS — `boundWorkspaceTx` reads the own-property `tx`, and
    // `effectiveDispatchWorkspace` returns the ctx workspace for a non-'*' caller.
    const tool = { needsWorkspaceTx: true } as unknown as Parameters<typeof bindCurrentCallerDispatch>[0];
    const ctx = { workspaceId: 'ws1', role: 'su', isSuperuser: true, tx: {} } as unknown as Parameters<
      typeof bindCurrentCallerDispatch
    >[3];

    let observed: readonly string[] | undefined;
    await bindCurrentCallerDispatch(tool, 'work_items:get', {}, ctx, () => {
      observed = readAmbientArgKeys();
      return Promise.resolve(null);
    });

    expect(observed).toEqual([]);
  });

  it('does not suppress a concurrent transport-path read', async () => {
    // Why this is an AsyncLocalStorage and not a module-scoped boolean: orchestration
    // and transport dispatches interleave across awaits, so a flag would leak one
    // dispatch's answer into another. A green result here is what makes that claim real.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const tool = { needsWorkspaceTx: true } as unknown as Parameters<typeof bindCurrentCallerDispatch>[0];
    const ctx = { workspaceId: 'ws1', role: 'su', isSuperuser: true, tx: {} } as unknown as Parameters<
      typeof bindCurrentCallerDispatch
    >[3];

    let insideScope: readonly string[] | undefined;
    const inFlight = bindCurrentCallerDispatch(tool, 'work_items:get', {}, ctx, async () => {
      insideScope = readAmbientArgKeys();
      await held;
      return null;
    });

    // Read from OUTSIDE while the orchestration dispatch is parked mid-flight.
    expect(readAmbientArgKeys()).toEqual([PROJECTION_ARG, VIEW_ARG]);
    release();
    await inFlight;
    expect(insideScope).toEqual([]);
  });
});
