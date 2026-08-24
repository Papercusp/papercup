/**
 * sessions:digest — "what WAS this session?", as a first-class answer.
 *
 * EI-10888. This is the single most common operator question about the session
 * store and it had no verb. Answering it for ~30 agents during the 2026-07-13 audit
 * meant: sessions:list → then, per session, a sessions:read of the TAIL → then hope
 * the last assistant turn happened to be a wind-down summary → then hand-batch the
 * whole thing through code:run. Six-plus calls and a heuristic standing in for a
 * query.
 *
 * And the heuristic is wrong exactly where it matters. It returns nothing for any
 * session that crashed, stalled, hit an auth wall, or is still running — i.e. every
 * session you actually need to know about. The one session that mattered most in
 * that audit (a lane parked 5h on an owner decision) came back BLANK, and was
 * written up as "no closing summary recorded" — which was true, and useless.
 *
 * The digest reads BOTH ends instead of guessing from one:
 *   - the HEAD (turn 0…) — the kickoff prompt / launch context / loop goal. This is
 *     what the session was FOR, and it exists even when the session died young.
 *     (It was itself unreachable until EI-10887 added sessions:read { order:'asc' }.)
 *   - the TAIL — where it actually got to, plus the provider-error signature that
 *     says whether it FINISHED or was KILLED (EI-10889, classifySessionEnd).
 *
 * A session that never wrote a summary still yields a real answer: what it was
 * launched to do, and why it stopped.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { parseSessionSelector, sessionSearchEnabled, disabledResult, SESSION_SOURCE_KINDS } from './_shared';
import { classifySessionEnd, type SessionEndReason } from '../../search/session-end-reason';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

/** Kickoff/closing excerpts are for ORIENTATION, not reading — keep them bounded so a
 *  100-session digest stays one affordable call rather than a transcript dump. */
const EXCERPT_MAX = 400;

/**
 * The row shape the digest query returns.
 *
 * EI-10968: `ctx.tx<Array<{…}>>` used to be DECORATIVE here — this handler is
 * role-gated (`requirePrincipal: false`), so its `ctx` was inferred as bare
 * `UnifiedToolContext`, whose `tx?: any` has no generic to bind at all
 * (TypeScript silently discarded the `<…>` type argument and handed back
 * `any`). The handler below is now typed `ctx: PapercuspUnifiedToolContext`
 * (`_tool-context.ts`), which gives `tx` a real `Sql` type — `ctx.tx<DigestRow[]>`
 * genuinely binds `DigestRow[]` now, so this interface (and the `rows` const's
 * own annotation, kept for readability) is checked against the query, not just
 * decorative.
 */
interface DigestRow {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  last_ts_ms: string | null;
  tool_call_count: number | null;
  kickoff_text: string | null;
  closing_text: string | null;
  total_matching: number;
}

function excerpt(text: string | null | undefined, max = EXCERPT_MAX): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * A wake-pump / loop-fire prompt states the loop's GOAL in its envelope — which is
 * the truest one-line answer to "what is this agent doing" for any looping session,
 * and far better than its first-ever prompt. Pull it out when present.
 */
function loopGoalOf(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const m = /(?:continuing your OWN warm session,?\s*(?:toward|MONITORING)[::]?\s*)(.+?)(?:\.\s|STATE:|Each wake|$)/i.exec(t);
  return m?.[1] ? excerpt(m[1], 240) : null;
}

export default defineTool({
  name: 'sessions:digest',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'What a session WAS — kickoff intent (its opening turn / loop goal), where it got to (closing turn), and WHY it stopped ' +
    '(endedReason: settled | active | awaiting_owner | auth_wall | usage_limit | model_error | context_limit), with evidence. ' +
    'Pass `session` for one, or `since`/`owner` to digest a whole window at once. Replaces the sessions:list → per-session ' +
    'sessions:read(tail) → "hope the last turn was a summary" pattern, which returns NOTHING for exactly the sessions that ' +
    'matter (crashed, wedged, still running).',
  guidance: {
    when:
      '"What were all these agents doing?", "what was session X?", triaging a window of sessions, or finding WEDGED sessions ' +
      '(endedReason auth_wall/model_error/context_limit ⇒ wedged:true — the agent is not going to recover on its own).',
    notWhen:
      'Reading actual transcript content — sessions:read. Searching for a phrase across sessions — sessions:search. ' +
      'Just enumerating sessions + counts — sessions:list.',
    chaining: 'sessions:digest { since } → pick the wedged/interesting ones → sessions:read { session } for the full turns.',
    returns:
      '{ ok, count, total, hasMore, wedged (how many are STUCK), digests: [{ source_kind, session_id, owner, harness_slug, cwd, ' +
      'first_ts, last_ts, turns, prompt_count, tool_call_count, kickoff (opening turn excerpt), loopGoal (if a looping session), ' +
      'closing (last assistant turn excerpt), endedReason, endedEvidence, wedged }] }. Timestamps are ISO-8601 with an offset.',
    seeAlso: ['sessions:list', 'sessions:read', 'sessions:search', 'coord:walls'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    session: z.string().max(200).optional().describe("One session id, '<source-kind>:<session-id>', or 'self'. Omit to digest a window (see since/owner)."),
    owner: z.string().max(120).optional().describe("Filter to one agent ownerId ('self' = the caller)."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional(),
    cwd_contains: z.string().max(200).optional().describe('Substring match on the session cwd.'),
    since: z.string().max(40).optional().describe('Only sessions active after this ISO timestamp (parsed as UTC).'),
    wedgedOnly: z.boolean().optional().describe('Only sessions that are STUCK (auth_wall / model_error / context_limit).'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    // Non-null: `tx` is optional on PapercuspUnifiedToolContext (must match the
    // framework's own optional `ctx.tx` for defineTool's overload resolution to
    // accept this handler — see _tool-context.ts) but is always bound for an
    // authenticated tool call. Destructured once so ctx.tx<T> below is actually
    // typed instead of a decorative type argument on `any` (EI-10968).
    const tx = ctx.tx!;
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 30;
    const now = Date.now();

    let sessionFilter: string | null = args.session ?? null;
    let sourceKind = args.source_kind;
    if (sessionFilter && sessionFilter !== 'self') {
      const selector = parseSessionSelector(sessionFilter, sourceKind);
      sessionFilter = selector.sessionId;
      sourceKind = selector.sourceKind;
    }
    if (args.session === 'self') {
      const { resolveSelfSession } = await import('../../search/self-session');
      const self = await resolveSelfSession(resolveAgentIdentity(ctx).ownerId ?? '');
      sessionFilter = self?.sessionId ?? null;
    }
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : (args.owner ?? null);

    // One pass: per-session aggregates + the FIRST user turn (the kickoff — what the
    // session was for) + the LAST assistant turn (where it got to / how it died).
    // DISTINCT ON gives both ends without a second round-trip per session, which is
    // the whole point: the old pattern cost one read PER SESSION.
    const rows: DigestRow[] = await tx<DigestRow[]>`
      WITH scoped AS (
        SELECT *
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND (${sessionFilter}::text IS NULL OR session_id = ${sessionFilter})
           AND (${owner}::text IS NULL OR owner = ${owner})
           AND (${sourceKind ?? null}::text IS NULL OR source_kind = ${sourceKind ?? null})
           AND (${args.cwd_contains ?? null}::text IS NULL OR cwd ILIKE '%' || ${args.cwd_contains ?? null} || '%')
           AND (${args.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${args.since ?? null}::timestamptz)
      ),
      agg AS (
        SELECT source_kind, session_id, count(*)::int AS turns,
               count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
               max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
               min(ts) AS first_ts_raw, max(ts) AS last_ts_raw
          FROM scoped
         GROUP BY source_kind, session_id
      ),
      kickoff AS (
        SELECT DISTINCT ON (source_kind, session_id) source_kind, session_id, text
          FROM scoped WHERE speaker = 'user'
         ORDER BY source_kind, session_id, turn_idx ASC
      ),
      closing AS (
        SELECT DISTINCT ON (source_kind, session_id) source_kind, session_id, text
          FROM scoped WHERE speaker = 'assistant'
         ORDER BY source_kind, session_id, turn_idx DESC
      ),
      state_agg AS (
        SELECT source_kind, session_id, sum(tool_call_count)::int AS tool_call_count
          FROM harness_shared.session_ingest_state
         WHERE session_id IS NOT NULL
         GROUP BY source_kind, session_id
      )
      SELECT a.source_kind, a.session_id, a.turns, a.prompt_count,
             a.owner, a.harness_slug, a.cwd,
             to_json(a.first_ts_raw) #>> '{}' AS first_ts,
             to_json(a.last_ts_raw)  #>> '{}' AS last_ts,
             (extract(epoch from a.last_ts_raw) * 1000)::bigint::text AS last_ts_ms,
             s.tool_call_count,
             k.text AS kickoff_text,
             c.text AS closing_text,
             count(*) OVER ()::int AS total_matching
        FROM agg a
        LEFT JOIN kickoff k USING (source_kind, session_id)
        LEFT JOIN closing c USING (source_kind, session_id)
        LEFT JOIN state_agg s USING (source_kind, session_id)
       ORDER BY a.last_ts_raw DESC NULLS LAST
       LIMIT ${limit}
    `;

    const total = rows[0]?.total_matching ?? 0;

    let digests = rows.map((r) => {
      const lastMs = r.last_ts_ms ? Number(r.last_ts_ms) : null;
      const cls = classifySessionEnd({
        lastAssistantText: r.closing_text,
        lastTsMs: lastMs,
        nowMs: now,
      });
      return {
        source_kind: r.source_kind,
        session_id: r.session_id,
        owner: r.owner,
        harness_slug: r.harness_slug,
        cwd: r.cwd,
        first_ts: r.first_ts,
        last_ts: r.last_ts,
        turns: r.turns,
        prompt_count: r.prompt_count,
        tool_call_count: r.tool_call_count,
        // What it was FOR. A looping session states its goal in the wake envelope —
        // strictly better than its first-ever prompt — so prefer that when present.
        kickoff: excerpt(r.kickoff_text),
        loopGoal: loopGoalOf(r.kickoff_text),
        // Where it got to. May legitimately be null (crashed before speaking) —
        // which is WHY kickoff/endedReason carry the answer instead.
        closing: excerpt(r.closing_text),
        endedReason: cls.reason as SessionEndReason,
        endedEvidence: cls.evidence,
        wedged: cls.wedged,
      };
    });

    if (args.wedgedOnly) digests = digests.filter((d) => d.wedged);
    const wedged = digests.filter((d) => d.wedged).length;
    const hasMore = total > rows.length;

    // { data } envelope (NOT hand-rolled inline JSON): the framework compact-encodes
    // the digests array for the agent transport, and the tool-data-shape ratchet holds.
    return {
      data: {
        ok: true,
        count: digests.length,
        total,
        hasMore,
        wedged,
        ...(wedged > 0
          ? {
              alert:
                `${wedged} session(s) are WEDGED (auth_wall / model_error / context_limit) — they are not doing anything ` +
                'and will not recover on their own. See endedReason + endedEvidence on each.',
            }
          : {}),
        note:
          "kickoff = the session's OPENING turn (what it was launched to do) — present even when the session crashed before " +
          'writing a summary. closing = its last assistant turn. endedReason is classified from the closing turn and always ' +
          'carries endedEvidence so you can verify it rather than trust the label.',
        digests,
      },
    };
  },
});
