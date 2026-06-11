/**
 * Scenario `toolOverride`s for the `su` suite.
 *
 * The su target's default tool executor returns a benign stub, which is right
 * for scenarios that only need the model's *emitted* tool call. Some scenarios
 * need a tool to return a SPECIFIC result to reproduce their failure mode —
 * that's what `toolOverride` is for (the framework wires it as the session's
 * dispatch override; the su target consults it before stubbing).
 */

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { ToolDispatchOverride } from '@papercusp/testing-shell/llm';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '');
}

/**
 * Returns `harness_required` for any `docs:*` / `plans:*` call that omits a
 * non-empty `harness` arg, and passes through (→ benign stub) when the harness
 * scope IS present. This faithfully reproduces SU-S01's failure surface: the
 * engineer must either pass `harness:'all'`/a slug up front, or RECOVER from
 * the error by re-calling with one — not stall ("can't, no harness selected").
 */
export const HARNESS_REQUIRED_GATE: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (/^(docs|plans):/.test(canon)) {
      const h = (args as Record<string, unknown> | null | undefined)?.harness;
      if (typeof h !== 'string' || !h.trim()) {
        return {
          isError: true,
          content: [
            {
              text: JSON.stringify({
                error: 'harness_required',
                message:
                  "which harness? pass harness:'all' for Papercusp's own (operator-level) docs/plans, or a managed harness slug.",
              }),
            },
          ],
        };
      }
    }
    return PASS_THROUGH;
  },
};

/**
 * Returns a Tier-3 HEADERLESS CSV result for `audit:list` (token-efficient-agent-io
 * P-013 read gate): a `format: csv` marker, a `[N]` count line, then N rows of
 * VALUES in the prompt-declared column order id,ts,actor,action,subject. The
 * read gate asserts the model maps row positions to columns — e.g. that the
 * actor (col 3) of the row whose action (col 4) is `locks:acquire` is `bob`.
 */
export const AUDIT_CSV_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'audit:list') {
      return {
        content: [
          {
            text:
              'format: csv\n[3]\n' +
              'au-1,1717,alice,plans:set-status,P-001\n' +
              'au-2,1718,bob,locks:acquire,harness-fs-watcher.ts\n' +
              'au-3,1719,carol,work_items:complete,WI-9',
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic results for SU-S12 (same-turn insight): the SUT's natural first
 * moves are memory/search/docs lookups around the just-fixed wedge, plus the
 * shared-tree write protocol (locks:acquire, coord:declare-intent). Benign
 * `{ok:true}` stubs left the model narrating test-frame artifacts and the
 * judge grading stub coping instead of the same-turn discipline (EI-133
 * class) — so give the lookups believable empty-ish results ("nothing written
 * up yet", which is exactly the state that makes the insight write mandatory)
 * and the write-protocol calls believable confirmations.
 */
export const ZOMBIE_LOCK_INSIGHT_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'memory:search' || canon === 'search:semantic') {
      return { content: [{ text: JSON.stringify({ results: [], note: 'no stored memories match' }) }] };
    }
    if (canon === 'search:fulltext') {
      return { content: [{ text: JSON.stringify({ hits: [], scope: a.scope ?? 'all' }) }] };
    }
    if (canon === 'docs:search') {
      return {
        content: [
          {
            text: JSON.stringify({
              hits: [
                {
                  slug: 'agent-insights/llm-429-check-the-transport-not-the-account',
                  section: 'agent-insights',
                  title: 'LLM 429s: check the transport, not the account',
                  snippet: 'Example of the insight format: one page per non-obvious root cause…',
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'docs:outline') {
      return {
        content: [
          {
            text: JSON.stringify({
              sections: [
                { section: 'agent-insights', pages: 42 },
                { section: 'system', pages: 31 },
                { section: 'testing', pages: 12 },
                { section: 'agent-policies', pages: 1 },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'plans:search') {
      return { content: [{ text: JSON.stringify({ hits: [] }) }] };
    }
    if (canon === 'locks:acquire') {
      return {
        content: [
          { text: JSON.stringify({ ok: true, lock_id: 'lk-s12-1', granted: true, paths: a.paths ?? [] }) },
        ],
      };
    }
    if (canon === 'coord:declare-intent') {
      return {
        content: [
          { text: JSON.stringify({ ok: true, presence: { ownerId: 'su-test', intent: a.intent ?? '' } }) },
        ],
      };
    }
    if (canon === 'memory:remember') {
      return { content: [{ text: JSON.stringify({ ok: true, id: 'mem-s12-1' }) }] };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic results for SU-S10 (claim-before-work): a concrete `plans:get`
 * payload for the scenario's plan plus believable claim confirmations. The
 * default benign stub starved the SUT of the plan's content, and the judged
 * runs failed on STUB ARTIFACTS, not the discipline under test (EI-133): the
 * model asked the user for item details the plan "should" have carried, or
 * fabricated implementation specifics. With a real-shaped payload the judge
 * measures claim-then-work behavior, not stub coping.
 */
export const WIDGET_EXPORT_PLAN: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'plans:get') {
      return {
        content: [
          {
            text: JSON.stringify({
              slug: 'widget-export-2026-06-01',
              frontmatter: { title: 'Widget export: CSV + XLSX download from the widget table', status: 'active' },
              now: {
                state:
                  'P-001 (export menu + format picker UI) shipped. Exporter backend not started; the picker is wired to a disabled stub.',
                next: 'Implement P-002 then P-003; both are scoped and unblocked.',
              },
              items: [
                { id: 'P-001', text: 'Export menu + format picker on the widget table toolbar', status: 'done' },
                {
                  id: 'P-002',
                  text: 'CSV exporter: defineTool widgets:export_csv (columns = visible grid columns, RFC 4180 quoting, streams via ctx.progress); wire the picker CSV entry to it',
                  status: 'todo',
                },
                {
                  id: 'P-003',
                  text: 'XLSX exporter: same column model via exceljs, one sheet per widget view; picker XLSX entry; blocked-by: P-002 (shares the column-model helper it introduces)',
                  status: 'todo',
                },
              ],
              decisions: [
                {
                  id: 'D-001',
                  title: 'Column model comes from the live grid state, not the schema',
                  body: 'Exports reflect what the user sees: visible columns + current sort/filter, read from the grid URL state.',
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'coord:declare-intent') {
      const items = Array.isArray(a.items) ? a.items : [];
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              presence: { ownerId: 'su-test', intent: a.intent ?? '' },
              claims: { claimed: items, alreadyHeld: [], conflicts: [], released: [] },
            }),
          },
        ],
      };
    }
    if (canon === 'plans:set-status') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              itemId: a.itemId ?? '',
              oldStatus: 'todo',
              newStatus: a.status ?? '',
              ...(a.status === 'wip' ? { claim: { holder: 'su-test', lease_sec: 1800 } } : {}),
            }),
          },
        ],
      };
    }
    if (canon === 'plan_items:claim') {
      return {
        content: [
          { text: JSON.stringify({ ok: true, claim_id: 'cl-test-1', item: a.item ?? '', lease_expires_in_sec: 1800 }) },
        ],
      };
    }
    return PASS_THROUGH;
  },
};
