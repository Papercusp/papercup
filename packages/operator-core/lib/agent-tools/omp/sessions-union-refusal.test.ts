/**
 * sessions-union-refusal.test.ts — WI-2141831: the DISCRIMINATED-UNION half of the shared
 * refusal helper, pinned against the REAL registered `omp:sessions` tool.
 *
 * WHY THIS EXISTS. D-104 measured `omp:sessions` as the worst rejecting verb in the table:
 * 66 rejections in 7 days, 100% of its calls, ten distinct agents, ~6.6 attempts each. D-105
 * recorded the cause as "a verb that does not declare `cwd`". Reading the schema shows that
 * is not quite it — `cwd` IS declared, on op=list/search/link, and NOT on op=get/state.
 *
 * That distinction is the whole bug. `mergedSchemaProperties` unions the branches' keys,
 * which is the RIGHT answer for "what could this tool ever accept" (the `accepts ONLY:`
 * list) and the WRONG one for "was this key accepted on THIS call". Under the merged view
 * `cwd` reads as accepted, the unrecognized-key set comes back empty, and the entire
 * correction mechanism stays silent on precisely the call that needed it — while zod still
 * refuses the call. Ten agents then re-derived the branch rule by hand, 6.6 tries each.
 *
 * The sibling unit tests in libs/generic/tooldef/src/corrected-call.test.ts exercise the
 * branch-selection logic against a hand-built schema. This file exists because that fixture
 * is a RECONSTRUCTION: it cannot catch `omp:sessions` moving `cwd` onto the shared RefShape,
 * a `strictArgs` change that stops strictifying union variants, or a zod upgrade that stops
 * emitting a leaf `unrecognized_keys` issue for a discriminated union. Each of those would
 * silently restore the original silence with every unit test still green.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/omp/sessions-union-refusal.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';

// Imported for its REGISTRATION side effect: lookupByMcpName reads the projected registry,
// which is populated as tool modules are loaded. Without this the lookup returns undefined
// and every assertion below fails on a missing tool rather than on the behaviour it pins.
import './sessions';

function ctx(runId: string) {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'papercusp-workspace',
    runId,
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as unknown as Parameters<typeof dispatchProjectedTool>[3];
}

async function refuse(args: Record<string, unknown>, runId: string) {
  const projected = lookupByMcpName('omp:sessions');
  expect(projected, 'omp:sessions must be registered').toBeTruthy();
  return dispatchProjectedTool(projected!, 'omp:sessions', args, ctx(runId), {});
}

describe('omp:sessions — a wrong-variant key is diagnosed as wrong-variant', () => {
  it('names cwd, drops it, and says it exists on ANOTHER variant', async () => {
    // The exact shape from D-104's table: `cwd` is real, just not on op='get'.
    const dispatched = await refuse(
      { op: 'get', sessionId: 's1', cwd: '/home/dev/project' },
      'omp-sessions-wrong-variant',
    );

    expect(dispatched.ok).toBe(false);
    expect(dispatched.error?.code).toBe('invalid_input');

    // 1. The key is IDENTIFIED at all. Pre-fix this was the failure: the merged view
    //    reported `cwd` as accepted, so unknownKeys was empty and correctedCall was null.
    const corrected = (dispatched.error?.meta?.invalidInput as
      | { correctedCall?: { args?: Record<string, unknown>; steps?: unknown[] } }
      | undefined)?.correctedCall;
    expect(corrected, 'a wrong-variant key must still produce a corrected call').toBeTruthy();

    // 2. The corrected args are EXECUTABLE — the caller's own values, minus the bad key.
    expect(corrected!.args).toEqual({ op: 'get', sessionId: 's1' });

    // 3. The diagnosis is the precise one. In particular the key is DROPPED, not
    //    "relocated" onto itself: before the branch-aware candidate pool landed, the
    //    merged pool contained `cwd` (from op=list/search/link), suggestArgName matched
    //    it exactly, and this came back as `{ action: 'relocated', target: 'cwd' }` — the
    //    value silently lost, the hint advising a move that is not a move.
    expect(corrected!.steps).toEqual([
      { rejectedArg: 'cwd', action: 'dropped', acceptedOnOtherVariant: true },
    ]);

    // 4. And the rendered text does not tell the reader the false thing. "declares no
    //    counterpart" would send an agent hunting for a synonym of a key that exists.
    const message = String(dispatched.error?.message ?? '');
    expect(message).toContain('NOT on the variant');
    expect(message).not.toContain('declares no counterpart');
  });

  it('CONTROL: a key on NO variant is still reported as having no counterpart', async () => {
    // Calibration. Without this, an implementation that labelled EVERY dropped key
    // `acceptedOnOtherVariant` would pass the case above — the assertions there are all
    // satisfied by a helper that never checks the merged view at all.
    const dispatched = await refuse(
      { op: 'get', sessionId: 's1', nosuchkey: 'x' },
      'omp-sessions-unknown-anywhere',
    );

    expect(dispatched.ok).toBe(false);
    const corrected = (dispatched.error?.meta?.invalidInput as
      | { correctedCall?: { steps?: Array<Record<string, unknown>> } }
      | undefined)?.correctedCall;
    expect(corrected).toBeTruthy();

    const step = corrected!.steps!.find((s) => s.rejectedArg === 'nosuchkey');
    expect(step).toBeTruthy();
    // The absence of the flag is the assertion: this key really has no home.
    expect(step!.acceptedOnOtherVariant).toBeUndefined();

    const message = String(dispatched.error?.message ?? '');
    expect(message).toContain('declares no counterpart');
    expect(message).not.toContain('NOT on the variant');
  });

  it('NON-REGRESSION: cwd on the variant that DOES declare it is not refused', async () => {
    // The fix must not start rejecting the calls the merged view was right about. op='list'
    // declares `cwd`, so this must fail (if at all) on something other than an unknown key.
    const dispatched = await refuse(
      { op: 'list', cwd: '/home/dev/project', limit: 1 },
      'omp-sessions-valid-variant',
    );

    const message = String(dispatched.error?.message ?? '');
    expect(message).not.toContain('Unrecognized key: "cwd"');
    expect(message).not.toContain('NOT on the variant');
  });

  it('documents that indexed context windows belong to sessions:read, not raw op=get', async () => {
    // `context` has meaningful window semantics on sessions:search/read. The raw
    // OMP reader has no center/ref, so accepting it on op='get' would only hide a
    // caller/tool mix-up rather than implement a useful operation.
    const dispatched = await refuse(
      { op: 'get', sessionId: 's1', context: 1 },
      'omp-sessions-get-context',
    );

    expect(dispatched.ok).toBe(false);
    const message = String(dispatched.error?.message ?? '');
    expect(message).toContain('context');

    const projected = lookupByMcpName('omp:sessions');
    expect(projected?.guidance?.when).toContain('sessions:read');
    expect(projected?.guidance?.when).toContain("not omp:sessions op='get'");
    expect(projected?.guidance?.notWhen).toContain("Do not pass context to op='get'");
    expect(projected?.guidance?.chaining).toContain('sessions:read { ref, context? }');
  });
});
