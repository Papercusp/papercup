/**
 * session:request-compaction — compact THIS session now, at a clean stopping point.
 *
 * agent-managed-compaction-2026-07-01. The agent calls this when it has reached a
 * good stopping point (typically near its soft compaction limit — see
 * config:set-compaction-limit and the per-turn `context: N/limit` signal). The
 * model cannot type a slash command itself, so the harness injects
 * `/compact <focus>` into the session's OWN psu-pty TUI — idle-gated (mode:'turn'),
 * so it runs AFTER this turn ends (the stopping point). The projected
 * `# Compact Instructions` (CLAUDE.md) carry the standing what-to-preserve
 * guidance; `focus` names this unit of work.
 *
 * Works for every psu-hosted TUI (claude / omp / codex — the host maps the backend
 * to its compact command; codex's native /compact takes no focus, so the hint is
 * dropped there). OMP + codex ALSO self-compact natively (omp compaction.enabled
 * defaults true; codex model_auto_compact_token_limit). The operator converse-brain
 * compacts programmatically. No live host ⇒ a clear error, never a silent no-op.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { findLiveHost, injectIntoHost, hostSupports } from '../../events/await/psu-pty-discovery';

/** Focus applied when the agent names none — mirrors the compaction.claude recipe. */
const DEFAULT_FOCUS =
  'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.';

/**
 * WI-1804: the continuation turn opened on the compacted context when the host supports
 * auto-continue. Derived from `focus` so the fresh context resumes THIS unit of work.
 * Re-orient first — a compaction is a stale-snapshot boundary, so the successor must
 * reconcile live fleet/claim state before acting (the classic post-compaction error).
 */
function defaultContinueNote(focus: string): string {
  return (
    'Continue where you left off — this is a fresh turn right after your compaction. ' +
    'First re-run coord:orient { afterCompaction: true } to reconcile live state AND get your ' +
    'recovery block (held-item checkpoints, armed-loop status, self-recall pointer). Anything ' +
    "the summary lost is still searchable: sessions:search { session:'self', mode:'verbatim' }. " +
    `Then resume: ${focus}`
  );
}

/**
 * EI-7032: `focus` / `continueNote` are HINTS to the compaction summarizer, not
 * load-bearing data. Rejecting an over-long one FAILED the whole compaction — and
 * that failure lands at the worst possible moment (the agent called this BECAUSE it
 * is at its context limit), forcing a wasted retry with a shorter string. Live data:
 * 40% of calls (130/321 in 24h) 400ed on "focus: Too big <=600 chars", nothing else.
 * Fix: truncate an over-long hint to the cap (…-marked) instead of rejecting, so the
 * compaction ALWAYS proceeds. A within-cap hint is returned unchanged, and the
 * published schema still advertises the cap so well-behaved clients keep it short.
 */
export function truncateHint(value: string, max: number): string {
  return value.length > max ? value.slice(0, Math.max(0, max - 1)) + '…' : value;
}

/** A string field that TRUNCATES to `max` (via truncateHint) instead of rejecting. */
function hintString(max: number) {
  return z.preprocess((v) => (typeof v === 'string' ? truncateHint(v, max) : v), z.string().max(max));
}

export default defineTool({
  name: 'session:request-compaction',
  description:
    'Compact THIS session now, at a clean stopping point (near your soft compaction limit). The harness types /compact into your own TUI; it runs after this turn ends. Pass focus to name what to preserve this compaction.',
  capability: 'coord:write',
  guidance: {
    when: 'You are near your compaction limit AND at a clean stopping point (a finished unit of work — tests green, an edit landed, a decision logged).',
    notWhen:
      'Mid-task — reach a stopping point first. To change WHEN this fires — config:set-compaction-limit.',
    seeAlso: ['config:set-compaction-limit (tune when this fires)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 10 } },
  args: z.object({
    focus: hintString(600)
      .optional()
      .describe(
        'What to preserve/emphasize in this compaction (defaults to the standard preserve set). Keep it ≤600 chars; an over-long focus is truncated, never rejected (EI-7032).',
      ),
    autoContinue: z
      .boolean()
      .optional()
      .describe(
        "After the compaction completes, open the fresh context on a continuation turn so you RESUME automatically instead of sitting idle post-summary (WI-1804). Default true. Needs a host that advertises the 'compact' capability; on an older host a plain /compact is injected (compaction still runs, no auto-continue).",
      ),
    continueNote: hintString(1000)
      .optional()
      .describe('Override the auto-continuation turn text opened on the compacted context. Defaults to a "continue + re-orient" note derived from focus. Over-long is truncated, never rejected (EI-7032).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const host = findLiveHost(identity.ownerId);
    if (!host) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_live_pty_host',
              note: 'No live psu-pty host for this session — /compact can only be injected into a psu-hosted TUI. If running interactively, type /compact yourself.',
            }),
          },
        ],
        isError: true,
      };
    }
    const focus = (args.focus ?? DEFAULT_FOCUS).trim();
    const autoContinue = args.autoContinue ?? true;
    // WI-1804: when the live host understands mode:'compact', let IT drive the sequence —
    // submit /compact, wait for the compaction TURN to complete (output-idle, the only place
    // "compaction done" is observable), then type the carry-note continuation. An old host
    // (no `caps`) falls back to the plain /compact turn inject: compaction still runs, no
    // auto-continue — so the rollout is a pure no-op until hosts advertise the capability.
    // compaction-context-loss-2026-07-05 P-001: force-ingest the caller's
    // transcript into the episodic index AT the moment of (deliberate) loss —
    // the server-mediated write-time flush that works for EVERY client
    // (claude/omp/codex), no PreCompact hook required. Fail-soft: the 2-min
    // ingest tick + the read-time self live-tail (D-002) cover any miss.
    try {
      const { resolveSelfSession } = await import('../../search/self-session');
      const self = await resolveSelfSession(identity.ownerId);
      if (self) {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath);
      }
    } catch { /* best-effort */ }
    const canAutoContinue = autoContinue && hostSupports(host, 'compact');
    const ok = canAutoContinue
      ? await injectIntoHost(host.sock, {
          mode: 'compact',
          data: (args.continueNote ?? defaultContinueNote(focus)).trim(),
          focus,
        })
      : await injectIntoHost(host.sock, { mode: 'turn', data: `/compact ${focus}` });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok,
            requested: ok,
            autoContinue: ok ? canAutoContinue : false,
            note: !ok
              ? 'Failed to reach the session TUI host socket; try again or compact manually.'
              : canAutoContinue
                ? 'Compaction queued — /compact runs when this turn ends, then the fresh context opens on a continuation turn automatically (WI-1804). Wrap up now and stop.'
                : `Compaction queued — /compact runs when this turn ends (idle-gated). Wrap up now and stop.${
                    autoContinue
                      ? ' (This host predates auto-continue, so it will NOT resume on its own — a loop/AUTO wake or your next turn picks the work back up.)'
                      : ''
                  }`,
          }),
        },
      ],
    };
  },
});
