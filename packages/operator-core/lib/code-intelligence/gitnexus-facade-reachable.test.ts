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
import { listAllProjectedTools, listFacadeNamespaces } from '@papercusp/agent-mcp';

import { GITNEXUS_FACADE_OPS, gitnexusFacade } from './gitnexus-facade.ts';
import graphQuery from '../agent-tools/gitnexus/query.ts';

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

  it('resolves as tools.graph.query in the code:run facade namespace', () => {
    // Registration through the barrel is necessary but NOT sufficient. `code:run`
    // does not call tools by their colon name — it builds a facade whose shape
    // comes from `listFacadeNamespaces`, and a script reaches a tool only as
    // `tools.<ns>.<verb>(...)`. A rename that keeps the tool registered while
    // moving its namespace would leave every scripted caller with an unknown-ns
    // error, which is D-057's failure with a different spelling.
    //
    // This asserts through the SAME function code:run uses rather than
    // re-deriving ns/verb from the name here; a guard that re-implements the
    // mapping it is guarding cannot see a change in the real one.
    const index = listFacadeNamespaces(listAllProjectedTools(), new Set([TOOL_NAME]));

    expect(
      index,
      `${TOOL_NAME} produced no code:run facade entry, so tools.graph.query is ` +
        'unreachable from a script even though the tool is registered.',
    ).toHaveLength(1);
    expect(index[0]).toMatchObject({ ns: 'graph', verbs: ['query'], toolNames: [TOOL_NAME] });
  });

  it('MEASURED: every curated op and both refusals answer through code:run', () => {
    // Recorded 2026-09-02 by running the ops through the live `graph:query`
    // tool inside `code:run` against gitnexus 1.6.9 at index commit acab51f9.
    // Pinned as data so the op set cannot drift out of the proof: an op added
    // to GITNEXUS_FACADE_OPS without a live measurement fails here rather than
    // shipping unproven, which is the P-006 obligation.
    const MEASURED_OPS = ['health', 'symbol', 'callers', 'callees', 'impact'] as const;
    const MEASURED_REFUSALS = ['references', 'text-search'] as const;

    expect([...GITNEXUS_FACADE_OPS].sort()).toEqual([...MEASURED_OPS].sort());
    for (const intent of MEASURED_REFUSALS) {
      expect(
        graphQuery.args.safeParse({ op: intent, name: 'probe' }).success,
        `${intent} must stay callable as an op so the redirect is reachable`,
      ).toBe(true);
    }
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
      if (tool === 'list_repos') {
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                repositories: [
                  {
                    name: 'papercusp',
                    indexedAt: '2026-08-24T04:00:00.000Z',
                    lastCommit: '0123456789abcdef0123456789abcdef01234567',
                    staleness: { commitsBehind: 0 },
                  },
                ],
              }),
            },
          ],
        });
      }
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'found',
              symbol: {
                name: args.name ?? '',
                kind: 'Function',
                filePath: 'pkg/target.ts',
                startLine: 0,
              },
            }),
          },
        ],
      });
    });

    // Bare names: namespacing to `gitnexus.<tool>` is the tool handler's job.
    expect(seen).toEqual(['list_repos', 'context']);
    expect(String(answer.error ?? '')).not.toMatch(/not configured|wiring fault/i);
  });

  it('accepts a refused intent as a typed op and returns its redirect before dispatch', async () => {
    expect(graphQuery.args.safeParse({ op: 'references', name: 'target' }).success).toBe(true);

    const dispatched: string[] = [];
    const result = (await graphQuery.handler(
      { op: 'references', name: 'target' } as never,
      {
        dispatchTool: async (tool: string) => {
          dispatched.push(tool);
          return { content: [] };
        },
      } as never,
    )) as { data: { intent: string; freshness: { health: string }; error: string | null } };

    expect(dispatched).toEqual([]);
    expect(result.data.intent).toBe('references');
    expect(result.data.freshness.health).toBe('unknown');
    expect(result.data.error).toMatch(/Use instead:.*lsp:query/i);
  });
});
