/**
 * tool-harness-scope.test.ts — the missing-harness-scope failure class.
 *
 * ~68 of the recorded tool-call failures (harness_shared.tool_invocations,
 * 2026-05-31) were "No harness in scope" / "resolveHarnessPlansDir: no harness"
 * — callers invoking a harness-scoped tool without the `harness` arg. The arg
 * is enforced IN-HANDLER (resolveHarnessPlansDir / harnessScopedCtx), not by the
 * dispatcher's harness gate (0 tools use harness:'required'). The failure mode
 * worth guarding structurally: a tool that resolves harness scope but doesn't
 * EXPOSE a `harness` arg — that would make scope unsatisfiable for callers.
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index';
import { listAllProjectedTools, lookupByMcpName } from '@papercusp/tooldef';

const projected = listAllProjectedTools();
const hasHarnessArg = (t: unknown) =>
  Boolean((t as { inputSchema?: { properties?: Record<string, unknown> } })?.inputSchema?.properties?.harness);

describe('harness-scoped tools expose the `harness` arg (missing-scope class)', () => {
  it('a meaningful set of tools accept a per-call harness arg', () => {
    const withHarness = projected.filter(hasHarnessArg);
    expect(withHarness.length).toBeGreaterThan(15); // ~28 observed
  });

  it('known harness-scoped tools expose `harness` so callers CAN satisfy scope', () => {
    // These are the exact tools that produced the "No harness in scope" failures.
    const names = ['plans:get', 'plans:items', 'plans:list', 'plans:lint', 'plans:search', 'docs:get', 'docs:outline'];
    for (const name of names) {
      const t = lookupByMcpName(name);
      expect(t, `tool ${name} present in registry`).toBeTruthy();
      expect(hasHarnessArg(t), `${name} exposes a harness arg`).toBe(true);
    }
  });
});
