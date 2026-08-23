/**
 * The recurrence guard for D-057 (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-006 / WI-40206).
 *
 * THE BUG. `gitnexusFacade` shipped in P-012 with a full test suite — unit and
 * integration — and was reachable by nobody. It had zero non-test callers, and
 * `configureGitnexusDispatch` was never called outside tests. Every test of the
 * facade itself passed, because each one wired the dispatch seam by hand before
 * asserting. That is the whole failure class: a facade's own tests supply the
 * very wiring whose absence is the defect, so they cannot see it.
 *
 * Two independent things had to be true for an agent to reach the curated
 * plane, and this guard pins both, because either one alone reverts silently:
 *
 *   1. A TOOL must exist and be registered THROUGH THE BARREL. `code:run`
 *      exposes only `tools.ns.verb(args)` — "no require/process/import" — so a
 *      facade with no tool of its own is unreachable from every agent surface.
 *      Like stop-fanout-installed.test.ts, this file imports the BARREL rather
 *      than the tool module: importing the module directly would register the
 *      tool as a side effect of the test and pass even with the barrel line
 *      deleted, anchoring the guard to the wrong thing.
 *
 *   2. An UNWIRED facade must REFUSE rather than answer empty. This is the
 *      property that made the bug survive: an unconfigured backend answering
 *      `sites: []` is indistinguishable from a healthy backend with nothing to
 *      say, so the plane could be dead for weeks while every caller read
 *      "no matches" as a real answer.
 */
import { describe, expect, it } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

import { GITNEXUS_FACADE_OPS, gitnexusFacade } from './gitnexus-facade.ts';

// Exactly what operator boot imports. NOT '../agent-tools/gitnexus/query'.
import '../agent-tools/index';

const TOOL_NAME = 'graph:query';

describe('the curated GitNexus facade is reachable by an agent', () => {
  it(
    'registers graph:query through the agent-tools barrel',
    { timeout: 180_000 },
    () => {
      const tool = listAllProjectedTools().find((c) => c.expose.mcp?.name === TOOL_NAME);

      expect(
        tool,
        `${TOOL_NAME} is not registered through agent-tools/index.ts. Without it ` +
          'gitnexusFacade has no tool, and code:run exposes only tools.ns.verb — ' +
          'so the curated graph plane is unreachable from every agent surface.',
      ).toBeTruthy();
      expect(tool?.agentRoles?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it('does not collide with the raw gitnexus.* plugin namespace', () => {
    // The bridge registers a bare `query` handler, surfaced as `gitnexus.query`.
    // A colon-form `gitnexus:query` would land on `tools.gitnexus.query` in the
    // code:run namespace — the curated and uncurated planes answering to one
    // name, which is worse than the gap this fix closes.
    expect(TOOL_NAME.startsWith('gitnexus:')).toBe(false);
    const names = listAllProjectedTools().map((c) => c.expose.mcp?.name);
    expect(names).not.toContain('gitnexus:query');
  });

  it('refuses with a wiring fault when no dispatcher is available, for every op', async () => {
    // No dispatcher passed, and the module global is unset in this process.
    // The answer must be a REFUSAL naming the fault — never an empty result.
    for (const op of GITNEXUS_FACADE_OPS) {
      const answer = await gitnexusFacade(op, { name: 'anySymbol' });

      expect(answer.error, `op '${op}' answered without an error`).toBeTruthy();
      expect(String(answer.error)).toMatch(/not configured|wiring fault/i);
      expect(
        String(answer.error),
        `op '${op}' must not let a wiring fault read as "no matches"`,
      ).toMatch(/do not read it as "no matches"/i);
      expect(answer.freshness?.health).toBe('unknown');
    }
  });

  it('prefers a per-call dispatcher over the module global', async () => {
    // The real dispatcher closes over the calling tool's ctx (principal +
    // workspace), so it is passed per call rather than published to a global.
    // If the facade ignored the argument, this would refuse as above.
    const seen: string[] = [];
    const answer = await gitnexusFacade('symbol', { name: 'pinModuleState' }, (tool, args) => {
      seen.push(tool);
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ symbols: [], relatedFiles: [], query: args.name ?? '' }),
          },
        ],
      });
    });

    // Bare names: namespacing to `gitnexus.<tool>` is the tool handler's job.
    expect(seen).toEqual(['context']);
    expect(String(answer.error ?? '')).not.toMatch(/not configured|wiring fault/i);
  });
});
