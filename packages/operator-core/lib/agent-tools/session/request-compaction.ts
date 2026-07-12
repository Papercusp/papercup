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
import { tagTurnForInjection } from '../../turn-provenance/turn-provenance';
import { provenanceLintField } from '../../carry-surface-provenance-lint';

/** Focus applied when the agent names none AND the carry-brief read fails —
 *  the static floor under the session-specific default (P-003 below). */
const DEFAULT_FOCUS =
  'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.';

/**
 * EI-10135: a harness-issued `/compact` is a slash COMMAND, so it cannot carry a
 * `⟦turn-origin⟧` envelope (an envelope prefix breaks the command) NOR a
 * UserPromptSubmit-hook provenance stamp — Claude Code does NOT fire the prompt
 * hook for slash commands (verified empirically 2026-07-12: a self-compaction ran
 * and resumed, yet no `/compact` prompt ever reached the hook; the turn is recorded
 * as a `<command-name>/compact</command-name>` client command, not a model prompt).
 * Absent this, the command turn renders byte-identical to an owner-typed `/compact`,
 * so a reader (human or a later agent) cannot tell the machine issued it — the exact
 * owner/agent confusion the turn-provenance system exists to kill (turn-provenance-
 * owner-vs-agent).
 *
 * This VISIBLE marker, PREFIXED to the focus of the harness-issued `/compact`, makes
 * the command turn self-identifying in the transcript in EVERY path (auto-continue
 * AND the plain-`mode:'turn'` fallback). It is a READER-FACING label, deliberately
 * NOT a ledger-verified stamp (which `/compact` structurally cannot have): it never
 * reaches the classifier (which skips `/compact`), so — unlike the ad-hoc labels the
 * ledger protocol replaced — it cannot cause a false owner/agent CLASSIFICATION. The
 * hook-VERIFIED `⟦turn-origin:self-compaction⟧` auto-continue continuation remains
 * the machine-verified signal; this marker only covers the command line itself and
 * the fallback path that has no tagged continuation. It is applied ONLY to the
 * `/compact` command's focus — NOT to the continuation note (already tagged).
 */
export const COMPACT_PROVENANCE_MARKER = '⟦machine-issued self-compaction — not owner-typed⟧';

/**
 * compaction-continuity-hardening-2026-07-07 P-003 + EI-8987: ONE best-effort
 * carry-brief build, shared by the default-focus derivation AND the stale-
 * checkpoint warning below (was two separate buildCarryBrief calls — wasteful,
 * since both want the SAME held-items read). Any failure yields `null`; every
 * caller treats that as "brief unavailable", never a thrown error.
 */
async function loadCarryBrief(
  ownerId: string,
  workspaceId?: string | null,
): Promise<import('../../carry-brief').CarryBrief | null> {
  try {
    const { buildCarryBrief } = await import('../../carry-brief');
    return await buildCarryBrief(ownerId, { workspaceId: workspaceId ?? undefined });
  } catch {
    return null;
  }
}

/** The session's CARRY BRIEF (held work-item ids, armed loop, standing facts,
 *  awaits, fleet pointer — as pointers, not copies) rendered as a focus string,
 *  so an agent that names no focus still hands the summarizer its real
 *  continuity anchors instead of the generic preserve set. Falls back to the
 *  static DEFAULT_FOCUS when the brief is empty/unavailable. */
async function carryBriefFocus(brief: import('../../carry-brief').CarryBrief | null): Promise<string> {
  if (!brief) return DEFAULT_FOCUS;
  try {
    const { renderCarryBriefFocus } = await import('../../carry-brief');
    const focus = renderCarryBriefFocus(brief).trim();
    if (focus.length > 0) return focus;
  } catch {
    /* fall through to the static floor */
  }
  return DEFAULT_FOCUS;
}

/** P-003 (fleet-deltas-leader-primitives): a held item's checkpoint older than this
 *  at compaction time is flagged STALE — the turns since it was written will NOT
 *  carry across the boundary. 15 min ≈ several monitor wakes / a full task step;
 *  younger than that, the checkpoint plausibly still covers the current unit. */
export const STALE_CHECKPOINT_WARN_MS = 15 * 60_000;

export interface CheckpointFlushWarning {
  id: string;
  title: string | null;
  /** 'missing' = never written (EI-8987, genuine state loss); 'stale' = written, but
   *  long enough ago that the turns since it will not carry (P-003). */
  reason: 'missing' | 'stale';
  /** Minutes since the checkpoint was written — only on reason:'stale'. */
  ageMinutes?: number;
}

/**
 * EI-8987 + P-003 (fleet-deltas-leader-primitives): a WARN-only (never refuse — a
 * hard-refuse gate on the tool an agent calls BECAUSE it is at its context limit
 * would strand it there on any gate bug, a worse failure than the one this catches)
 * proactive flush-integrity check over the caller's held work-items:
 *   - 'missing' — NO checkpoint at all (the highest-risk case: a compacted-away
 *     transcript with zero durable carry-note is a genuine state loss);
 *   - 'stale'   — a checkpoint OLDER than STALE_CHECKPOINT_WARN_MS (the WI-3549
 *     class: the flush happened, but so much has happened since that the summary
 *     boundary will drop unparked state anyway).
 * Best-effort: an unavailable brief yields an empty list, never blocks compaction.
 */
export function staleCheckpointWarnings(
  brief: import('../../carry-brief').CarryBrief | null,
  nowMs: number = Date.now(),
): CheckpointFlushWarning[] {
  if (!brief) return [];
  const out: CheckpointFlushWarning[] = [];
  for (const h of brief.heldItems) {
    if (h.checkpoint === null) {
      out.push({ id: h.id, title: h.title, reason: 'missing' });
    } else if (
      typeof h.checkpointUpdatedAtMs === 'number' &&
      nowMs - h.checkpointUpdatedAtMs > STALE_CHECKPOINT_WARN_MS
    ) {
      out.push({
        id: h.id,
        title: h.title,
        reason: 'stale',
        ageMinutes: Math.round((nowMs - h.checkpointUpdatedAtMs) / 60_000),
      });
    }
  }
  return out;
}

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
    // ONE best-effort brief build feeds both the default-focus derivation AND the
    // EI-8987 stale-checkpoint warning below (was two separate buildCarryBrief
    // calls before this pass).
    const brief = await loadCarryBrief(identity.ownerId, identity.workspaceId);
    const focus = (args.focus ?? '').trim() || (await carryBriefFocus(brief));
    const staleCheckpoints = staleCheckpointWarnings(brief);
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
    // turn-provenance P-002 (turn-provenance-owner-vs-agent-2026-07-11): the
    // continuation note is typed into the PTY after the compaction turn ends —
    // byte-identical to the owner typing — so envelope+ledger-tag it as
    // `self-compaction` for the UserPromptSubmit hook. The bare `/compact <focus>`
    // fallback is a TUI slash COMMAND, not a prompt — tagging would break it.
    const continuation = (() => {
      const note = (args.continueNote ?? defaultContinueNote(focus)).trim();
      try {
        return tagTurnForInjection({ sid: identity.ownerId, origin: 'self-compaction', text: note }).taggedText;
      } catch {
        return note; // provenance must never break a compaction
      }
    })();
    // EI-10135: prefix the machine-origin marker to the focus of the actual /compact
    // command (BOTH the host-driven mode:'compact' and the plain mode:'turn' fallback),
    // so the command turn is self-identifying in the transcript. Kept OFF the plain
    // `focus` var so it never leaks into the continuation note (already tagged) or the
    // provenance lint below — only the injected /compact command carries it.
    const compactFocus = `${COMPACT_PROVENANCE_MARKER} ${focus}`;
    const ok = canAutoContinue
      ? await injectIntoHost(host.sock, {
          mode: 'compact',
          data: continuation,
          focus: compactFocus,
        })
      : await injectIntoHost(host.sock, { mode: 'turn', data: `/compact ${compactFocus}` });
    // EI-8987: the compaction is already QUEUED at this point (idle-gated — it fires
    // after THIS turn ends), so a warning here is still actionable: the turn hasn't
    // ended yet, so the agent reading this result can fire one more
    // work_items:checkpoint call for the flagged item(s) before it truly stops —
    // and the already-queued compaction will still pick up that fresh checkpoint.
    const missing = staleCheckpoints.filter((s) => s.reason === 'missing');
    const stale = staleCheckpoints.filter((s) => s.reason === 'stale');
    const staleNote =
      ok && staleCheckpoints.length > 0
        ? ` ⚠ flush-integrity:${
            missing.length > 0
              ? ` ${missing.length} held work-item(s) have NO checkpoint written (${missing.map((s) => s.id).join(', ')}) — write one now (work_items:checkpoint) before you actually stop, or that state will not carry.`
              : ''
          }${
            stale.length > 0
              ? ` ${stale.length} held work-item(s) have a STALE checkpoint (${stale
                  .map((s) => `${s.id} ${s.ageMinutes}m old`)
                  .join(', ')}) — everything since it was written will NOT carry; refresh it now if this unit progressed since.`
              : ''
          }`
        : '';
    // WI-3801: warn-only nudge over the two free-text carry hints this call writes
    // (focus always; continueNote only when the caller passed one explicitly — the
    // synthesized defaultContinueNote is machine-authored, nothing to lint).
    const provenanceLint = provenanceLintField(
      [focus, args.continueNote].filter((s): s is string => Boolean(s && s.trim())).join('\n'),
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok,
            requested: ok,
            autoContinue: ok ? canAutoContinue : false,
            staleCheckpoints,
            ...(provenanceLint ? { provenanceLint } : {}),
            note:
              (!ok
                ? 'Failed to reach the session TUI host socket; try again or compact manually.'
                : canAutoContinue
                  ? 'Compaction queued — /compact runs when this turn ends, then the fresh context opens on a continuation turn automatically (WI-1804). Wrap up now and stop.'
                  : `Compaction queued — /compact runs when this turn ends (idle-gated). Wrap up now and stop.${
                      autoContinue
                        ? ' (This host predates auto-continue, so it will NOT resume on its own — a loop/AUTO wake or your next turn picks the work back up.)'
                        : ''
                    }`) + staleNote,
          }),
        },
      ],
    };
  },
});
