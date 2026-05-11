/**
 * ui:dispatch — fire an intent at a browser tab and wait for the
 * result.
 *
 * Flow:
 *   1. INSERT into ui_intents with status='pending'.
 *   2. Long-poll for the row to leave 'pending' (set by the
 *      browser-side dispatcher's POST /api/ui/intents/:id/result).
 *   3. Return result/error to the agent.
 *
 * If the tab doesn't pick up the intent within `timeout_ms` we mark
 * it status='timeout' and return that to the agent. The browser tab
 * will skip stale timeouts because its UPDATE clause requires
 * status='pending'.
 *
 * Built-in intents (always available): set_url, snapshot,
 * read_visible_text, focus, scroll_into_view, click.
 *
 * Feature-registered intents are page-mounted — call `ui:get_state`
 * first if you need to confirm the page that owns the intent is on
 * screen.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { ensureUiIntentsTable } from '@/lib/ensure-schema';

const ui = generated.ui_intentsInHarness_shared;

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export default defineTool({
  name: 'ui:dispatch',
  description:
    'Dispatch a UI intent to a browser tab and wait for the result. Defaults client_id to ctx.uiClientId (the tab that spawned the agent). Built-in intents: set_url ({params:{...}}), snapshot ({selector?,mode?}), read_visible_text, focus, scroll_into_view, click. Pages can register additional intents via useUiIntent(name, handler).',
  capability: 'ui:dispatch',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    /** Target tab. Defaults to ctx.uiClientId. */
    client_id: z.string().optional(),
    /** Intent name, e.g. "set_url" or a feature-registered name. */
    intent: z.string().min(1).max(128),
    /** Args object passed to the intent handler. */
    args: z.record(z.string(), z.unknown()).optional(),
    /** Long-poll budget; default 5000ms, max 60000ms. */
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  }),
  async handler(args, ctx) {
    const clientId = args.client_id ?? ctx.uiClientId ?? null;
    if (!clientId) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'client_id_required: pass client_id or invoke from a tab-spawned context (ctx.uiClientId).',
        }],
      };
    }
    const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const intentArgs = args.args ?? {};

    await ensureUiIntentsTable();
    const { db } = getOrgPg();

    const principalSlug = ctx.principal?.slug ?? (ctx.isSuperuser ? 'system:operator' : `agent:${ctx.role ?? 'unknown'}`);

    const inserted = await db
      .insert(ui)
      .values({
        client_id: clientId,
        intent: args.intent,
        args: intentArgs as any,
        requested_by: principalSlug,
      })
      .returning({ id: ui.id });
    const id = Number(inserted[0]!.id);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db
        .select({ status: ui.status, result: ui.result, error_message: ui.error_message })
        .from(ui)
        .where(eq(ui.id, BigInt(id)))
        .limit(1);
      const row = rows[0];
      if (row && row.status !== 'pending') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id,
              status: row.status,
              result: row.result ?? null,
              error: row.error_message ?? null,
            }),
          }],
          isError: row.status === 'error',
        };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // Timeout: mark the row so the browser tab won't act on it
    // even if it comes back online later.
    await db
      .update(ui)
      .set({
        status: 'timeout',
        completed_at: dsql`now()` as any,
        error_message: 'dispatch_timeout',
      })
      .where(and(eq(ui.id, BigInt(id)), eq(ui.status, 'pending')));
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          id,
          status: 'timeout',
          error: `dispatch_timeout: no response from client_id=${clientId} within ${timeoutMs}ms. The tab may be closed or unresponsive.`,
        }),
      }],
    };
  },
});
