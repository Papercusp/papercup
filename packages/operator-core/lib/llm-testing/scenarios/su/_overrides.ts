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
import { encode } from '@papercusp/result-encoding';

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
    const a = (args ?? {}) as Record<string, unknown>;
    if (/^(docs|plans):/.test(canon)) {
      const h = a.harness;
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

      // Once the engineer has supplied the load-bearing harness scope, give it
      // enough evidence to answer the user's orientation request. Returning an
      // empty read here made the scenario self-contradictory: its deterministic
      // gate passed on the harness arg while the judge correctly penalised the
      // model for inventing the requested plan/owner/status from a vacuum.
      if (canon === 'plans:search' || canon === 'plans:list') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              harness: h,
              plans: [{
                slug: 'spec-md-deprecation-2026-08-18',
                title: 'Retire spec-md compatibility paths',
                status: 'ready',
                itemCounts: { done: 4, wip: 1, todo: 2 },
                now: {
                  state: 'P-005 removes the final write-side compatibility adapter',
                  next: 'P-006 migrate the remaining readers; P-007 delete the adapter',
                },
              }],
            }),
          }],
        };
      }
      if (canon === 'plans:get') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              plan: {
                slug: 'spec-md-deprecation-2026-08-18',
                title: 'Retire spec-md compatibility paths',
                status: 'ready',
                owner: 'platform-maintainers',
                now: {
                  state: 'P-005 is in progress; four earlier migration items are done',
                  next: 'Migrate the two remaining readers, then remove the adapter',
                },
              },
            }),
          }],
        };
      }
      if (canon === 'docs:search' || canon === 'docs:outline') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              hits: [{
                slug: 'agent-insights/spec-md-deprecation-migration',
                title: 'Spec-md deprecation migration',
                excerpt:
                  'The plan store is canonical. Migrate remaining readers before deleting the compatibility adapter.',
              }],
            }),
          }],
        };
      }
      if (canon === 'docs:get') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              pages: [{
                slug: 'agent-insights/spec-md-deprecation-migration',
                title: 'Spec-md deprecation migration',
                body:
                  'Use plans:get for live status. The migration is incomplete until the two remaining readers move and the compatibility adapter is deleted.',
              }],
            }),
          }],
        };
      }
    }
    return PASS_THROUGH;
  },
};

/**
 * Source-backed read results for SU-S02. The scenario asks for concrete UI
 * verification guidance, so an all-empty docs world is not a valid test of the
 * playbook: it rewards either refusing the task or fabricating remembered
 * commands. These excerpts mirror the canonical `testing/agent-e2e` and
 * `verify-ui-via-staging-3170-dedicated-webview` docs while leaving the model
 * to select the docs tools and synthesize the answer itself.
 */
export const TAURI_APP_VERIFICATION_CONTEXT: ToolDispatchOverride = {
  override(name) {
    const canon = canonical(name);
    if (canon === 'docs:search' || canon === 'docs:outline') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            hits: [
              {
                slug: 'testing/agent-e2e',
                title: 'Agent E2E playbook — driving the operator like a user',
                excerpt:
                  'Drive the Papercusp Tauri desktop shell with tauri-agent-tools; the standalone web app is retired.',
              },
              {
                slug: 'agent-insights/verify-ui-via-staging-3170-dedicated-webview',
                title: 'Verifying UI changes end-to-end via :3170 + a dedicated webview instance',
                excerpt:
                  'Use a dedicated debug webview pinned to staging and target its bridge by exact process id.',
              },
            ],
          }),
        }],
      };
    }
    if (canon === 'docs:get') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            pages: [{
              slug: 'testing/agent-e2e',
              title: 'Agent E2E playbook — driving the operator like a user',
              body:
                'Start the Tauri shell with `cd papercusp-desktop && npm run dev`, or attach to an already-running debug shell. Drive the webview with `tauri-agent-tools` and pin commands to the selected process id. Use an exit-coded `check` assertion for DOM-verifiable acceptance; a screenshot alone is observational.',
            }],
          }),
        }],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * The three audit rows BOTH encoding arms of the SU-S08 read gate carry. Shared
 * so the arms differ ONLY in encoding — that is what makes them comparable as an
 * A/B (EI-136). `audit-read-fixtures.test.ts` asserts the CSV literal below
 * still carries exactly these rows.
 *
 * The question the gate asks: who is the ACTOR on the row whose ACTION is
 * `locks:acquire`? Answering needs column 4 to find the row, then column 3 of
 * that row → `bob`. `alice`/`carol` are the decoy actors of the other two rows,
 * so a column-shift misread names one of them.
 */
export const AUDIT_S08_ROWS = [
  { id: 'au-1', ts: 1717, actor: 'alice', action: 'plans:set-status', subject: 'P-001' },
  { id: 'au-2', ts: 1718, actor: 'bob', action: 'locks:acquire', subject: 'harness-fs-watcher.ts' },
  { id: 'au-3', ts: 1719, actor: 'carol', action: 'work_items:complete', subject: 'WI-9' },
] as const;

/**
 * ARM A (historical — NOT the shipped contract since EI-136): `audit:list` as a
 * Tier-3 HEADERLESS CSV — a `format: csv` marker, a `[N]` count line, then N
 * rows of bare VALUES whose column order lives only in the prompt's "## Wire
 * schemas" legend, thousands of tokens away.
 *
 * Measured against this arm, sonnet-4-6 COLUMN-SHIFT-MISREAD ~1/3 of runs (2
 * pass / 1 fail over 3, groundedness variance 1.89) — which is why production
 * moved to arm B. Retained so the A/B stays re-runnable: an encoding change is
 * only meaningful against the arm it replaced.
 *
 * The literal is kept verbatim (not re-derived) because it was verified
 * byte-faithful against a live `audit:list` wire sample — note CSV does NOT
 * quote a value containing `:` here, whereas TOON does.
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
 * ARM B (the SHIPPED contract): `audit:list` as self-describing TOON. Same three
 * rows, but the field names ride INLINE in the row header —
 * `[3]{id,ts,actor,action,subject}:` — so the position→column mapping is local
 * to the data and needs no legend lookup. That locality is the whole fix for
 * EI-136; the self-description costs ~30 chars ONCE PER RESULT regardless of row
 * count.
 *
 * Derived from the real `encode(…, 'toon')` rather than hand-written, so this
 * fixture cannot drift from what production actually emits (a hand-copied
 * encoding is exactly the fixture artifact that makes a green scenario
 * meaningless). The `format:` marker line is prepended by the serializer, not
 * the encoder, so it is added here to match the wire.
 */
export const AUDIT_TOON_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'audit:list') {
      return {
        content: [{ text: `format: toon\n${encode(AUDIT_S08_ROWS, 'toon')}` }],
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
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'plans:search') {
      return { content: [{ text: JSON.stringify({ hits: [] }) }] };
    }
    if (canon === 'docs:author') {
      const slug = typeof a.slug === 'string' ? a.slug : 'zombie-plan-lock-transport-drop';
      const section = typeof a.section === 'string' ? a.section : 'agent-insights';
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              ref: `${section}/${slug}`,
              slug,
              section,
              harness: a.harness ?? 'engineering',
              status: a.status ?? 'active',
              path: `apps/operator-docs/src/content/docs/${section}/${slug}.mdx`,
              anchored: true,
              read: { slugs: [`${section}/${slug}`], harness: a.harness ?? 'engineering' },
            }),
          },
        ],
      };
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

/**
 * Realistic context for SU-S13 (code:run batch adoption,
 * code-execution-tool-orchestration B-CX). The task is the canonical "do X for
 * each of N" shape: `work_items:list` returns 12 open items WITHOUT the blocked
 * detail, so answering "which are blocked and why" requires a per-item
 * `work_items:get` over all 12 — exactly the loop the playbook's CODE_RUN_NUDGE
 * says to collapse into ONE `code:run`. The override also gives `code:tools` a
 * believable namespace index and `code:run` a believable summary so the smart
 * path "succeeds" and the model isn't punished (by a stub artifact) for taking it.
 */
const S13_WORK_ITEMS = Array.from({ length: 12 }, (_, i) => ({
  id: `WI-${200 + i}`,
  title:
    [
      'Wire the export picker to the CSV backend',
      'Flaky test: harness-fs-watcher debounce',
      'Add retry to the gateway pool client',
      'Migrate widgets table to nuqs state',
      'Audit log row drops NUL bytes',
      'Design token: brand-accent contrast',
      'Bee mail inbox pagination',
      'Coord wake-queue SSE push',
      'Plan lint: smart-quote detector',
      'Sandbox npm-install EROFS',
      'Operator palette poll → push',
      'Schema migration 331 drift',
    ][i] ?? `Work item ${i}`,
  kind: 'feature',
}));

export const CODE_RUN_BATCH_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:list') {
      // Deliberately omits per-item state → the blocked check needs a get-per-item.
      return { content: [{ text: JSON.stringify({ items: S13_WORK_ITEMS, count: S13_WORK_ITEMS.length }) }] };
    }
    if (canon === 'work_items:get') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => {
        const n = Number(id.split('-')[1] ?? 0);
        const blocked = n % 4 === 0; // a deterministic ~quarter are blocked
        return {
          ok: true as const,
          id,
          workItem: {
            id,
            state: blocked ? 'blocked' : 'open',
            ...(blocked ? { blockedReason: 'waiting on an upstream dependency', blockedBy: [`WI-${n - 1}`] } : {}),
          },
        };
      });
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    if (canon === 'code:tools') {
      // The cheap namespace index (no args) or typed signatures (with namespaces).
      if (!a.namespaces && !a.names) {
        return {
          content: [
            {
              text: JSON.stringify({
                namespaces: [
                  { ns: 'work_items', verbs: ['list', 'get', 'setState', 'complete'] },
                  { ns: 'coord', verbs: ['declareIntent', 'send', 'inbox'] },
                  { ns: 'plans', verbs: ['list', 'get', 'setStatus'] },
                ],
                count: 10,
                hint: 'Call code:tools { namespaces:[...] } for full typed signatures, then write a code:run script.',
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            text:
              'declare const tools: {\n  work_items: {\n    list(args?: { status?: string }): Promise<unknown>;\n' +
              '    get(args: { id?: string; ids?: string[] }): Promise<unknown>;\n  };\n  call(toolName: string, args?: unknown): Promise<unknown>;\n};',
          },
        ],
      };
    }
    if (canon === 'code:run') {
      // A believable summary for a "which are blocked" batch script.
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              summary: {
                scanned: S13_WORK_ITEMS.length,
                blocked: ['WI-200', 'WI-204', 'WI-208'],
                reasons: {
                  'WI-200': 'waiting on an upstream dependency',
                  'WI-204': 'waiting on an upstream dependency',
                  'WI-208': 'waiting on an upstream dependency',
                },
              },
              dryRun: !!a.dryRun,
              plannedMutations: [],
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S15 (small-batch adoption): the user names a FEW items (3) to check — a
 * modest fan-out. The token win still favors ONE code:run over 3 round-trips, so
 * the engineer should batch even here ("reach for it a lot"). `work_items:get`
 * returns per-item state; the blocked check needs a get per id.
 */
export const SMALL_BATCH_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:get') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => {
        const n = Number(id.split('-')[1] ?? 0);
        return {
          ok: true as const,
          id,
          workItem: {
            id,
            state: n % 2 === 0 ? 'blocked' : 'open',
            ...(n % 2 === 0 ? { blockedReason: 'awaiting review' } : {}),
          },
        };
      });
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    if (canon === 'code:tools') {
      return { content: [{ text: JSON.stringify({ namespaces: [{ ns: 'work_items', verbs: ['get'] }], count: 1 }) }] };
    }
    if (canon === 'code:run') {
      return { content: [{ text: JSON.stringify({ ok: true, summary: { blocked: ['WI-302'] } }) }] };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S16 (batch WRITE via dry-run): the user asks to mark every OPEN work item
 * to `wip` — a valid homogeneous WRITE over a collection. The engineer should
 * collapse it into one native bulk `work_items:set_state { ids, state }` call,
 * not loop the scalar form or route a homogeneous mutation through code:run.
 */
const S16_OPEN_ITEMS = Array.from({ length: 9 }, (_, i) => ({ id: `WI-${400 + i}`, state: 'open' }));
export const BATCH_WRITE_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:list') {
      return { content: [{ text: JSON.stringify({ items: S16_OPEN_ITEMS, count: S16_OPEN_ITEMS.length }) }] };
    }
    if (canon === 'work_items:set_state') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => ({ ok: true, id, appliedState: a.state ?? null }));
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    if (canon === 'code:tools') {
      return { content: [{ text: JSON.stringify({ namespaces: [{ ns: 'work_items', verbs: ['list', 'setState'] }], count: 2 }) }] };
    }
    if (canon === 'code:run') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              dryRun: !!a.dryRun,
              plannedMutations: a.dryRun ? S16_OPEN_ITEMS.map((w) => ({ tool: 'work_items:set_state', args: { id: w.id, state: 'wip' } })) : [],
              summary: { updated: a.dryRun ? 0 : S16_OPEN_ITEMS.length },
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic single-fact result for SU-S14 (no code:run over-application): a
 * `harness:status` snapshot. The question is answerable in ONE direct call, so
 * the engineer must NOT wrap it in `code:run` (the nudge's "NOT WHEN: a single
 * tool call" rule). PASS_THROUGH for anything else (incl. a benign stub for an
 * unexpected code:run, which the assert then flags).
 */
export const HARNESS_STATUS_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'harness:status') {
      return {
        content: [
          {
            text: JSON.stringify({
              slug: 'sheets',
              phase: 'production',
              features: { total: 14, done: 11, in_progress: 2, blocked: 1 },
              lastActivity: '2026-06-21T04:12:00Z',
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S17 (reach for coord:orient at wake): a believable one-call bootstrap so the
 * engineer who calls coord:orient { intent } once isn't punished by a stub. The
 * fanned-out primitives PASS_THROUGH to a benign stub — the assert flags the fan;
 * the override just lets the smart (bundle) path succeed.
 */
export const ORIENT_BOOTSTRAP_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const a = (args ?? {}) as Record<string, unknown>;
    if (canonical(name) === 'coord:orient') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              me: { assignments: [{ id: 'WI-512', title: 'Gateway pool retry', state: 'wip' }], lane: ['P-003'], load: 1 },
              claimable: [{ id: 'WI-540', title: 'Audit log NUL bytes' }, { id: 'WI-541', title: 'Palette poll → push' }],
              inbox: { summary: { total: 1, unread: 1 }, recent: [{ from: 'mug', text: 'prioritize the gateway retry' }] },
              planEvents: { total: 2, recent: [{ kind: 'item_status_changed', plan: 'gateway-pool', item: 'P-002' }] },
              memory: { query: a.intent ?? '', hits: [{ id: 'mem-1', memory: 'gateway retries must route through the account pool (EI-456)' }] },
              intentDeclared: !!a.intent,
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S21 (reach for the bulk READ arg over a per-id hand-loop;
 * bulk-endpoint-standardization-2026-06-21 P-007). work_items:list returns 6 open
 * items WITHOUT the detail the question needs (assignee + parent), so answering
 * "who owns each and what's the parent" requires work_items:get over all 6 — which
 * is now ONE bulk `work_items:get { ids:[…] }` call (every repeated-call read is
 * dual-arity, n=1 ≡ bulk-of-one), not 6 round-trips. The override returns the
 * keyed-array bulk envelope when called with `ids` (the smart path "succeeds"), and
 * a believable single-item envelope when called with a scalar `id` (so a hand-loop
 * is not punished by a stub — the assert, not the stub, flags the fan-out).
 */
const S21_OPEN_ITEMS = Array.from({ length: 6 }, (_, i) => ({ id: `WI-${600 + i}`, title: `Open item ${600 + i}`, kind: 'feature' }));
function s21WorkItem(id: string) {
  const n = Number(id.split('-')[1] ?? 0);
  return { id, kind: 'feature', state: 'open', assignee: `su-${(n % 3) + 1}`, parent: n % 2 === 0 ? `F-${n - 1}` : null };
}
export const BULK_GET_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:list') {
      return { content: [{ text: JSON.stringify({ items: S21_OPEN_ITEMS, count: S21_OPEN_ITEMS.length }) }] };
    }
    if (canon === 'work_items:get') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => ({ ok: true as const, id, workItem: s21WorkItem(id) }));
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S18 (do NOT over-apply coord:orient on a single inbox check): a believable
 * coord:inbox result. "Any new messages?" is one direct coord:inbox call — wrapping
 * it in coord:orient over-fetches assignments + claimable + plan-events + a memory
 * recall + a declare, the over-application the guard catches.
 */
export const COORD_INBOX_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'coord:inbox') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              summary: { total: 2, unread: 1 },
              entries: [
                { id: 'm-1', from: 'su-9140a', kind: 'message', text: 'rebased your branch, re-pull' },
                { id: 'm-2', from: 'mug', kind: 'notify', text: 'gateway retry landed' },
              ],
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

// ===========================================================================
// Delta-protocol fixtures + override (agent-tool-delta-protocol-2026-06-22
// P-007 / D-007 / D-008).
//
// The delta-merge scenarios (S23/S24/S25) reproduce the LLM-facing
// semantic-delta read against `work_items:list` (a list-of-rows view): the
// override is STATEFUL — call 1 returns a FULL snapshot (mode:full), call 2 a
// DELTA (mode:delta) of changes since the snapshot's cursor, call 3+ the
// re-fetched current FULL list (mode:full). The result shape follows plan
// D-003: `{ ok, mode, cursor, items, counts, note }`; the delta carries a
// legible inline contract (like S08's `format: csv` marker) so the real su
// persona — which does not yet know the protocol — can interpret it AND knows
// to re-fetch full when it no longer holds the base.
//
// `makeDeltaSnapshotOverride` returns a FRESH instance each call so a scenario
// can expose it via a GETTER (`get toolOverride()`), giving per-run-fresh
// call-count state across `runMatrix` repeats (the runner reads
// `scenario.toolOverride` once per run).
// ===========================================================================

/** The view rows are stable-keyed work items (id + title). */
interface DeltaRow {
  id: string;
  title: string;
}

/** The base full snapshot (call 1, mode:full). */
export const DELTA_BASE_ROWS: DeltaRow[] = [
  { id: 'WI-7001', title: 'Export picker → CSV backend' },
  { id: 'WI-7002', title: 'Flaky harness-fs-watcher debounce' }, // REMOVED by the delta
  { id: 'WI-7003', title: 'Audit log drops NUL bytes' },
  { id: 'WI-7004', title: 'Gateway pool naive-retry loop' }, // UPDATED by the delta
  { id: 'WI-7005', title: 'Operator palette poll-to-push' },
];

/** The current truth after applying the delta — WI-7002 removed, WI-7004
 *  retitled, WI-7006 added. This is what call 3+ (the re-fetch) returns and
 *  what a correct merge must reproduce. */
export const DELTA_CURRENT_ROWS: DeltaRow[] = [
  { id: 'WI-7001', title: 'Export picker → CSV backend' },
  { id: 'WI-7003', title: 'Audit log drops NUL bytes' },
  { id: 'WI-7004', title: 'Gateway pool circuit-breaker' }, // updated title
  { id: 'WI-7005', title: 'Operator palette poll-to-push' },
  { id: 'WI-7006', title: 'Sandbox npm-install EROFS' }, // added
];

const DELTA_FULL_SNAPSHOT = {
  ok: true,
  mode: 'full',
  cursor: 'wil-c1',
  count: DELTA_BASE_ROWS.length,
  items: DELTA_BASE_ROWS,
};

const DELTA_CHANGES = {
  ok: true,
  mode: 'delta',
  cursor: 'wil-c2',
  // Legible inline contract so the SUT can interpret it and knows the base rule.
  note:
    'mode=delta: these are the CHANGES since cursor wil-c1, NOT the full list. ' +
    'Apply them to the full work_items:list snapshot you fetched earlier ' +
    '(change=added|updated|removed; an updated/added row carries its full new data). ' +
    'If you no longer have that earlier snapshot in context, do NOT guess — ' +
    're-call work_items:list to get a fresh mode:full list.',
  items: [
    { change: 'removed', id: 'WI-7002' },
    { change: 'updated', id: 'WI-7004', data: { id: 'WI-7004', title: 'Gateway pool circuit-breaker' } },
    { change: 'added', id: 'WI-7006', data: { id: 'WI-7006', title: 'Sandbox npm-install EROFS' } },
  ],
  counts: { added: 1, updated: 1, removed: 1, unchanged: 3 },
};

const DELTA_REFETCH_FULL = {
  ok: true,
  mode: 'full',
  cursor: 'wil-c2',
  count: DELTA_CURRENT_ROWS.length,
  items: DELTA_CURRENT_ROWS,
};

/**
 * A fresh STATEFUL `work_items:list` override: 1st call → full snapshot, 2nd →
 * delta, 3rd+ → re-fetched current full list. Each call is one model tool
 * invocation. Returns a new instance per call (expose via a `get toolOverride()`
 * getter for per-run-fresh state across matrix repeats). PASS_THROUGH for any
 * other tool.
 */
export function makeDeltaSnapshotOverride(): ToolDispatchOverride {
  let calls = 0;
  return {
    override(name) {
      if (canonical(name) !== 'work_items:list') return PASS_THROUGH;
      calls += 1;
      const body = calls === 1 ? DELTA_FULL_SNAPSHOT : calls === 2 ? DELTA_CHANGES : DELTA_REFETCH_FULL;
      return { content: [{ text: JSON.stringify(body) }] };
    },
  };
}

/**
 * SU-S19 (reach for harness:overview on "state of X"): a faithful, self-contained
 * one-call overview (status + escalation record + bounded open-issues snapshot)
 * so the engineer who calls harness:overview once isn't punished by a stub. The
 * snapshot count deliberately equals `recent.length`: both rows fit under the
 * production default limit of 25, so advertising a larger count would invent
 * missing detail and provoke a follow-up this tool-selection scenario does not
 * intend to measure (WI-2146314).
 */
export const HARNESS_OVERVIEW_RESULT: ToolDispatchOverride = {
  override(name, args) {
    const a = (args ?? {}) as Record<string, unknown>;
    if (canonical(name) === 'harness:overview') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              harness: a.harness ?? 'sheets',
              status: { phase: 'production', features: { total: 14, done: 11, in_progress: 2, blocked: 1 } },
              escalations: {
                hasEscalation: true,
                escalation: 'esc-1: validator stuck on F-12; retry is awaiting the validator trace',
                supervisorNotes: 'Validator owner is investigating; next update follows the trace.',
                mtimeMs: 1788602400000,
              },
              issues: {
                count: 2,
                recent: [
                  { id: 'EI-880', title: 'export picker disabled stub', severity: 'major', state: 'open' },
                  { id: 'EI-881', title: 'formula import drops locale', severity: 'minor', state: 'open' },
                ],
              },
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};
