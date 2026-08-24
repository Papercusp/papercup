/**
 * WI-41007 — unavailable-capability diagnostics and fallback policy.
 *
 * P-015 calls for a typed diagnostic when a script (or a saved recipe replayed
 * from another host) statically references a capability that is not available
 * HERE, and for an explicit no-fallback policy. `contract-preflight.ts` implements
 * that in `unavailableRefFailure`, which distinguishes two cases that look
 * identical from inside a script but are opposite operationally:
 *
 *   capability_unavailable — the tool is not in this host's catalog at all
 *                            (a recipe authored where it existed, replayed where
 *                            it does not). Re-provision or re-author.
 *   capability_denied      — the tool EXISTS but this caller's role may not
 *                            invoke it. A permission answer, not a missing one.
 *
 * Collapsing the two sends the reader to the wrong fix, which is why the
 * distinction is asserted here rather than merely "preflight refuses".
 *
 * Until this file, that branch had NO test: `mixed-script.test.ts` imports
 * `inspectScriptContract` only to wire the happy path, and the assertions on
 * `capability_unavailable` elsewhere in the tree (recipe-contract.test.ts,
 * recipes/recipes.test.ts, staged-rollout-gate.test.ts) cover the recipe-contract
 * and rollout-gate layers, not this door.
 *
 * FALLBACK POLICY: both diagnostics must report `executed: false` at
 * `phase: 'preflight'`. The refusal is the whole policy — there is deliberately no
 * degraded second attempt on another backend, because silently succeeding by a
 * route the author did not choose is what the typed diagnostic exists to prevent.
 */
import { describe, expect, it, vi } from 'vitest';
import { type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, ToolResult } from '@papercusp/tooldef';
import {
  currentCallerRecipeCatalog,
  inspectScriptContract,
  type OrchestrationCallerSurface,
} from './contract-preflight';

function fixtureTool(name: string, effect: 'read' | 'write' = 'read'): ProjectedTool {
  return {
    pluginName: 'wi41007-fixture',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    expose: { mcp: { name } },
    fn: (): ToolResult => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  } as unknown as ProjectedTool;
}

function testContext(): UnifiedToolContext {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'ws-wi41007',
    harnessSlug: 'papercusp',
    role: 'su',
    isSuperuser: true,
    runId: 'run-wi41007',
    uiClientId: 'su-wi41007',
  } as unknown as UnifiedToolContext;
}

/** The catalog this host actually has. `capability:bash` exists; `capability:teleport` never does. */
const PRESENT_TOOL = 'capability:bash';
const ABSENT_TOOL = 'capability:teleport';

function surfaceWith(options: { present: string[]; allowed: string[] }): OrchestrationCallerSurface {
  const tools = options.present.map((name) => fixtureTool(name));
  const allowed = new Set(options.allowed);
  return { tools, allowed, catalog: currentCallerRecipeCatalog(tools, allowed) } as OrchestrationCallerSurface;
}

const scriptCalling = (toolName: string): string => {
  const [ns, verb] = toolName.split(':');
  return `const out = await tools.${ns}.${verb}({ cmd: 'true' });\nreturn { ok: true, out };`;
};

async function inspect(script: string, surface: OrchestrationCallerSurface) {
  return inspectScriptContract({ script: { source: script }, ctx: testContext(), surface });
}

describe('WI-41007 — unavailable-capability diagnostics at the orchestration door', () => {
  it('reports capability_unavailable when the referenced tool is not in this host catalog', async () => {
    const result = await inspect(
      scriptCalling(ABSENT_TOOL),
      surfaceWith({ present: [PRESENT_TOOL], allowed: [PRESENT_TOOL] }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'capability_unavailable', path: 'script.source' },
    });
  });

  it('names the specific missing capability, so the reader knows WHAT to provision', async () => {
    const result = await inspect(
      scriptCalling(ABSENT_TOOL),
      surfaceWith({ present: [PRESENT_TOOL], allowed: [PRESENT_TOOL] }),
    );

    // A diagnostic that refuses without naming the ref sends the author hunting.
    const error = (result as { error: { message: string; capability?: string } }).error;
    expect(error.message).toContain('teleport');
    expect(error.capability).toMatch(/^tools:/);
  });

  it('reports capability_denied — NOT unavailable — when the tool exists but the caller may not invoke it', async () => {
    const result = await inspect(
      scriptCalling(PRESENT_TOOL),
      // Present in the catalog, absent from this caller's allowed set.
      surfaceWith({ present: [PRESENT_TOOL], allowed: [] }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'capability_denied' },
    });
    expect((result as { error: { message: string } }).error.message).toContain('may not invoke');
  });

  it('keeps the two diagnostics DISTINCT for the same script shape', async () => {
    // The operational fix differs (provision vs. grant), so collapsing these to one
    // code would be a regression even though both are "preflight refused".
    const unavailable = await inspect(
      scriptCalling(ABSENT_TOOL),
      surfaceWith({ present: [PRESENT_TOOL], allowed: [PRESENT_TOOL] }),
    );
    const denied = await inspect(
      scriptCalling(PRESENT_TOOL),
      surfaceWith({ present: [PRESENT_TOOL], allowed: [] }),
    );

    const codeOf = (r: unknown) => (r as { error: { code: string } }).error.code;
    expect(codeOf(unavailable)).toBe('capability_unavailable');
    expect(codeOf(denied)).toBe('capability_denied');
    expect(codeOf(unavailable)).not.toBe(codeOf(denied));
  });

  it('never executes on either diagnostic — the refusal IS the fallback policy', async () => {
    for (const surface of [
      surfaceWith({ present: [PRESENT_TOOL], allowed: [PRESENT_TOOL] }), // -> unavailable
      surfaceWith({ present: [PRESENT_TOOL], allowed: [] }), // -> denied
    ]) {
      const script = surface.allowed.size > 0 ? scriptCalling(ABSENT_TOOL) : scriptCalling(PRESENT_TOOL);
      const result = await inspect(script, surface);
      expect(result).toMatchObject({ ok: false, executed: false, phase: 'preflight' });
    }
  });

  // VACUITY CONTROL. Every assertion above is a `toMatchObject` on a result object;
  // if the branch were never reached (a thrown preflight, a differently-shaped
  // refusal), some of those could pass without measuring the diagnostic at all.
  // This keeps a deliberately WRONG expectation in the file permanently and proves
  // it is rejected — so the suite is known-falsifiable without mutating the shared
  // tree to find out (CLAUDE.md's module-subject tier).
  it('control: a WRONG expected code is actually caught, so the assertions are reached', async () => {
    const result = await inspect(
      scriptCalling(ABSENT_TOOL),
      surfaceWith({ present: [PRESENT_TOOL], allowed: [PRESENT_TOOL] }),
    );

    expect(() =>
      expect(result).toMatchObject({ error: { code: 'capability_denied' } }),
    ).toThrow();
  });

  // CALIBRATION. Without this, every assertion above would still pass if the
  // capability gate refused EVERYTHING — a detector that always fires measures
  // nothing. The same script shape must get PAST the gate when the tool is both
  // present and allowed.
  it('calibration: the same script clears the capability gate when present AND allowed', async () => {
    const result = await inspect(
      scriptCalling(PRESENT_TOOL),
      surfaceWith({ present: [PRESENT_TOOL], allowed: [PRESENT_TOOL] }),
    );

    const code = (result as { ok: boolean; error?: { code?: string } }).error?.code;
    expect(code).not.toBe('capability_unavailable');
    expect(code).not.toBe('capability_denied');
  });
});
