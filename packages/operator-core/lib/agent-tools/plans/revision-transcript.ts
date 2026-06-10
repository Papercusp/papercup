/**
 * plans:revision-transcript — the conversation behind a revision.
 *
 * plan-agent-launch-2026-05-21, Phase 2 (P-008 / D-002).
 *
 * A revision records *what* changed and (often) a one-line rationale.
 * This verb retrieves the *conversation* that produced it — the raw
 * back-and-forth. It is deliberately **scoped**: paginated by `cursor`
 * and narrowable by `query`, never a whole-transcript dump (D-002) —
 * a launched agent that pulled an entire transcript would blow its
 * own context window.
 *
 * Routing by the revision's `session_kind`:
 *   - `plan_run`     → the `plan_run_turns` store (the populated case).
 *   - `null`         → a direct `/admin/plans` editor save — no
 *                      conversation; `available: false`.
 *   - `git_backfill` → a revision reconstructed from a git commit —
 *                      no conversation; `available: false`.
 *   - `operator_chat` / `agent_chat` → not yet produced by any writer
 *                      (D-016: `resolvePlanSessionRef` only ever
 *                      yields `plan_run`); `available: false` with
 *                      `session_kind_unsupported` until a writer
 *                      exists (D-020).
 *
 * `available: false` is a normal result, not an error — the UI
 * (P-019) shows a "direct edit" tag for it. Only a missing revision
 * or a DB failure is an error.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { getPlanRevisionById } from './revisions';
import { readPlanRunTranscript } from './runs';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const argsSchema = z.object({
  // z.coerce on the numerics so the same schema accepts numeric MCP
  // args and string query-params from the /api/admin/plans route.
  revisionId: z.coerce
    .number()
    .int()
    .positive()
    .describe('Global plan_revisions id (from plans:revisions rows).'),
  harness: harnessArg,
  query: z
    .string()
    .optional()
    .describe('Case-insensitive literal substring filter over turn content.'),
  cursor: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Return turns after this seq — pass back the prior nextCursor.'),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .describe('Page size (default 20, max 100).'),
});

type TranscriptArgs = z.infer<typeof argsSchema>;

/** Why a revision has no plan-run transcript. */
type UnavailableReason =
  | 'no_session'
  | 'git_backfill'
  | 'session_kind_unsupported';

export default defineTool({
  name: 'plans:revision-transcript',
  description:
    'The conversation behind a plan revision — scoped: paginated by cursor, narrowable by query, never a whole-transcript dump. Returns turns from the plan-run transcript; revisions from a direct editor save or a git backfill report available:false.',
  guidance: {
    when: 'You need the reasoning behind a specific revision — the raw conversation, drilled into around a decision via query/cursor.',
    notWhen:
      'You want the revision list with rationales — plans:revisions. You want the plan body — plans:get. Never pull a whole transcript unscoped.',
    chaining:
      'plans:revisions → plans:revision-transcript { revisionId, query } → page with cursor.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args: TranscriptArgs, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      // Workspace scope: revision rows are RLS-isolated per workspace
      // (audit P-008 / mig 218); resolve it from the harness arg.
      const harnessSlug = resolveCtxHarnessSlug(harnessScopedCtx(args.harness, ctx));
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const revision = await getPlanRevisionById(args.revisionId, { workspaceId: scope.workspaceId });
      if (!revision) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'not_found',
                revisionId: args.revisionId,
              }),
            },
          ],
        };
      }

      const base = {
        revisionId: revision.id,
        planSlug: revision.planSlug,
        seq: revision.seq,
        sessionKind: revision.sessionKind,
      };

      // Routing — only `plan_run` has a retrievable transcript today.
      let unavailable: UnavailableReason | null = null;
      if (revision.sessionKind === 'git_backfill') {
        unavailable = 'git_backfill';
      } else if (
        revision.sessionKind === 'operator_chat' ||
        revision.sessionKind === 'agent_chat'
      ) {
        unavailable = 'session_kind_unsupported';
      } else if (revision.sessionKind !== 'plan_run' || !revision.sessionId) {
        // null session_kind (direct edit) — or a plan_run kind with no
        // session id, which should not happen.
        unavailable = 'no_session';
      }

      if (unavailable) {
        ctxAny.metadata?.({ revisionId: revision.id, available: false });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ...base,
                available: false,
                reason: unavailable,
                turns: [],
                nextCursor: null,
              }),
            },
          ],
        };
      }

      const page = await readPlanRunTranscript(revision.sessionId!, {
        query: args.query,
        cursor: args.cursor,
        limit: args.limit,
      });
      ctxAny.metadata?.({
        revisionId: revision.id,
        available: true,
        turnCount: page.turns.length,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...base,
              available: true,
              query: args.query ?? null,
              turns: page.turns,
              nextCursor: page.nextCursor,
            }),
          },
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'transcript_unavailable',
              message: message.slice(0, 400),
              revisionId: args.revisionId,
            }),
          },
        ],
      };
    }
  },
});
