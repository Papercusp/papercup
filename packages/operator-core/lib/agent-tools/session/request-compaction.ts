/**
 * session:request-compaction — cut THIS session at a clean stopping point and
 * respawn it on fresh context, carrying the deterministic carry document.
 *
 * agent-managed-compaction-2026-07-01, rebuilt under deterministic-context-carry
 * P-018/P-022 (WI-4998, owner terminal state 2026-07-14 "remove the compact call
 * entirely"): native `/compact` — Claude Code's LLM summarizer — is RETIRED. The
 * agent still calls this tool at a good stopping point (typically near its soft
 * compaction limit — see config:set-compaction-limit and the per-turn
 * `context: N/limit` signal), but the harness no longer types a slash command.
 * Instead it sends the psu-pty host a `carry-respawn`: after this turn ends the
 * host KILLS the CLI child and RELAUNCHES it in the same pane with
 *
 *   1. the deterministic carry document (P-009/P-010/P-011 producers, rendered to
 *      the constant budget) as the successor's system-prompt addendum, and
 *   2. a first prompt — the owner's final message when it is still OPEN (the
 *      P-010 contract: an unanswered owner turn arrives as a live prompt, never
 *      quoted history), else a continue+re-orient note derived from `focus`.
 *
 * No native summarizer runs anywhere in this path; the transitional residual LLM
 * pass (P-019) audits deterministic-carry boundaries separately and stays armed
 * until its per-class evidence retires it. A host that predates the
 * `carry-respawn` capability gets a loud error, NOT a `/compact` fallback —
 * fresh launches always carry the capability, and the hard-wall death detector
 * (improvements watchdog) recovers the rare straggler.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { findLiveHost, injectIntoHost, hostSupports } from '../../events/await/psu-pty-discovery';
import { tagTurnForInjection } from '../../turn-provenance/turn-provenance';
import { carryProvenanceFields } from '../../carry-surface-provenance-stamp';
import { buildOwnerRespawnLaunchSpec } from '../../carry-respawn';
import { resolveModelSpecForOwner } from '../../compaction-usage';
import { modelWindowForSpec } from '../../agent-config-constants';
import {
  staleCheckpointWarnings,
  STALE_CHECKPOINT_WARN_MS,
  type CheckpointFlushWarning,
} from '../../enforcement-gate';
import { runFlushGate } from '../../enforcement-gate-io';

// Re-exported for back-compat: the flush-integrity detector + its shape now live
// in enforcement-gate.ts (the single source shared with the P-016 enforcement
// tier), but this tool's warn path — and any importer — keeps its old surface.
export { staleCheckpointWarnings, STALE_CHECKPOINT_WARN_MS, type CheckpointFlushWarning };

/** Focus applied when the agent names none AND the carry-brief read fails —
 *  the static floor under the session-specific default (P-003 below). */
const DEFAULT_FOCUS =
  'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.';

/** Window fallback when the model spec cannot be resolved — the conservative
 *  200k default every ≤200k Claude session actually runs. */
const FALLBACK_EFFECTIVE_WINDOW_TOKENS = 200_000;

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
 *  so an agent that names no focus still hands the successor its real
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

/**
 * The successor's first prompt when no owner message is open (WI-1804 lineage):
 * derived from `focus` so the fresh context resumes THIS unit of work.
 * Re-orient first — a respawn is a stale-snapshot boundary, so the successor must
 * reconcile live fleet/claim state before acting (the classic post-boundary error).
 */
function defaultContinueNote(focus: string): string {
  return (
    'Continue where you left off — this is your fresh successor process right after a ' +
    'deterministic carry-respawn; your carry document is in the system prompt. ' +
    'First re-run coord:orient { afterCompaction: true } to reconcile live state AND get your ' +
    'recovery block (held-item checkpoints, armed-loop status, self-recall pointer). Anything ' +
    "the carry dropped is still searchable: sessions:search { session:'self', mode:'verbatim' }. " +
    'DISTRUST a near-limit context gauge on your first turns — it can lag the respawn by up to ' +
    'a watchdog pass (~2 min) and describe your DEAD predecessor; never re-compact on it alone. ' +
    `Then resume: ${focus}`
  );
}

/**
 * EI-7032: `focus` / `continueNote` are HINTS folded into the successor's first
 * prompt, not load-bearing data. Rejecting an over-long one FAILED the whole
 * boundary — and that failure lands at the worst possible moment (the agent
 * called this BECAUSE it is at its context limit), forcing a wasted retry with a
 * shorter string. Live data: 40% of calls (130/321 in 24h) 400ed on "focus: Too
 * big <=600 chars", nothing else. Fix: truncate an over-long hint to the cap
 * (…-marked) instead of rejecting, so the boundary ALWAYS proceeds. A within-cap
 * hint is returned unchanged, and the published schema still advertises the cap
 * so well-behaved clients keep it short.
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
    'Compact THIS session now, at a clean stopping point (near your soft compaction limit). After this turn ends the harness cuts the process and respawns it on fresh context with the deterministic carry document as launch context (P-018 — native /compact is retired); the successor resumes automatically. Pass focus to name what to resume.',
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
        'What to resume/emphasize after the respawn (defaults to your carry-brief anchors). Keep it ≤600 chars; an over-long focus is truncated, never rejected (EI-7032).',
      ),
    autoContinue: z
      .boolean()
      .optional()
      .describe(
        'Deprecated no-op: a carry-respawn always resumes (the successor launches with a first prompt). Accepted for wire-compat with older callers.',
      ),
    continueNote: hintString(1000)
      .optional()
      .describe(
        "Override the successor's first prompt used when no owner message is open. Defaults to a \"continue + re-orient\" note derived from focus. Over-long is truncated, never rejected (EI-7032).",
      ),
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
              note: 'No live psu-pty host for this session — a carry-respawn can only be driven through a psu-hosted TUI. If running interactively, end the session at a clean point and relaunch.',
            }),
          },
        ],
        isError: true,
      };
    }
    // P-022: native /compact is retired — there is deliberately NO fallback for a
    // host that predates the carry-respawn capability. Fresh launches always
    // carry it; a stale host rides until the hard wall, where the improvements
    // watchdog's death detector ("Prompt is too long") recovers the session.
    if (!hostSupports(host, 'carry-respawn')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'host_predates_carry_respawn',
              note: 'This psu-pty host predates the carry-respawn capability and native /compact is retired (P-022). Flush your state (work_items:checkpoint / loop:checkpoint) and keep working — the watchdog death-detector recovers the session at the wall — or have the session relaunched to pick up a current host.',
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
    // P-016 enforcement gate: the WARN above becomes teeth. Unflushed state
    // (missing/stale held checkpoint, or an armed loop with no carry-note) HOLDS
    // the boundary ONCE, naming the flush; a retry that still hasn't flushed
    // gets a system-written mechanical fallback and proceeds. The gate is bounded,
    // fail-OPEN, and env-disable-able (enforcement-gate-io), so it can never
    // reintroduce the strand this tool's warn-only design was avoiding.
    const gateNowMs = Date.now();
    const gate = await runFlushGate({
      boundary: 'compaction',
      ownerId: identity.ownerId,
      workspaceId: identity.workspaceId ?? '*',
      sessionId: identity.ownerId,
      sinceIso: new Date(gateNowMs - 30 * 60_000).toISOString(),
      brief,
      nowMs: gateNowMs,
    });
    if (gate.verdict === 'refuse') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              requested: false,
              error: 'flush-required',
              tripwires: gate.tripwires,
              note: gate.refusalText,
            }),
          },
        ],
        isError: true,
      };
    }
    // compaction-context-loss-2026-07-05 P-001: force-ingest the caller's
    // transcript into the episodic index AT the moment of (deliberate) loss —
    // the server-mediated write-time flush that works for EVERY client
    // (claude/omp/codex), no PreCompact hook required. Fail-soft: the 2-min
    // ingest tick + the read-time self live-tail (D-002) cover any miss.
    let self: Awaited<
      ReturnType<typeof import('../../search/self-session').resolveSelfSession>
    > | null = null;
    try {
      const { resolveSelfSession } = await import('../../search/self-session');
      self = await resolveSelfSession(identity.ownerId);
      if (self) {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath);
      }
    } catch { /* best-effort */ }
    // P-018: assemble the successor launch spec from the deterministic carry
    // producers. Assembly failure leaves the CURRENT session intact (a loud
    // error, never a blind cut) — the agent retries after addressing it.
    let effectiveWindowTokens = FALLBACK_EFFECTIVE_WINDOW_TOKENS;
    try {
      const spec = await resolveModelSpecForOwner(identity.ownerId);
      if (spec) effectiveWindowTokens = modelWindowForSpec(spec);
    } catch { /* conservative fallback stands */ }
    const spec = await buildOwnerRespawnLaunchSpec(identity.ownerId, {
      effectiveWindowTokens,
      buildOpts: {
        workspaceId: identity.workspaceId ?? undefined,
        transcriptPath: self?.filePath,
        transcriptSourceKind: self?.sourceKind,
        boundaryDeliberate: true,
      },
    });
    if (!spec) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              requested: false,
              error: 'carry_build_failed',
              note: 'The deterministic carry could not be assembled; this session remains alive and uncut. Flush state (work_items:checkpoint) and retry.',
            }),
          },
        ],
        isError: true,
      };
    }
    // P-010: an OPEN owner message becomes the successor's first prompt (a live
    // ask, never quoted history) — spec.firstPrompt already carries it through
    // the ONE shared kickoff source (deriveLaunchPromptText). Otherwise the
    // successor opens on the continue+re-orient note, envelope-tagged
    // `self-compaction` so the turn-provenance hook classifies it machine-origin
    // (turn-provenance-owner-vs-agent P-002).
    const openOwnerQuestion = spec.openOwnerQuestion.crossesOpenOwnerMessage;
    const firstPrompt =
      spec.firstPrompt ??
      (() => {
        const note = (args.continueNote ?? defaultContinueNote(focus)).trim();
        try {
          return tagTurnForInjection({ sid: identity.ownerId, origin: 'self-compaction', text: note }).taggedText;
        } catch {
          return note; // provenance must never break a boundary
        }
      })();
    const ok = await injectIntoHost(host.sock, {
      mode: 'carry-respawn',
      data: firstPrompt,
      systemPromptAddendum: spec.systemPromptAddendum,
    });
    // EI-8987: the cut is already QUEUED at this point (idle-gated — it fires
    // after THIS turn ends), so a warning here is still actionable: the turn
    // hasn't ended yet, so the agent reading this result can fire one more
    // work_items:checkpoint call for the flagged item(s) before it truly stops.
    // The carry ADDENDUM was already assembled above, but a late checkpoint
    // still reaches the successor through the work-item's own re-injection
    // surface on next invocation — checkpoints never ride the addendum alone.
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
    // P-010 informative note: when the owner's final message is open, the cut
    // does NOT lose it — it IS the successor's first prompt.
    const openQuestionNote =
      ok && openOwnerQuestion
        ? " ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE" +
          ' boundary. It is NOT lost — it becomes your successor’s first prompt — but if you' +
          ' have room, answer it before you stop.'
        : '';
    // WI-3801 lint + P-014 turn-ref verification/origin stamp over the two
    // free-text carry hints this call writes (focus always; continueNote only
    // when the caller passed one explicitly — the synthesized
    // defaultContinueNote is machine-authored, nothing to lint).
    const provenanceFields = await carryProvenanceFields(
      [focus, args.continueNote].filter((s): s is string => Boolean(s && s.trim())).join('\n'),
      identity.ownerId,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok,
            requested: ok,
            respawn: ok,
            budgetChars: spec.budgetChars,
            firstPromptSource: spec.firstPrompt ? 'open-owner-message' : 'continuation-note',
            staleCheckpoints,
            openOwnerQuestion,
            ...(gate.verdict === 'mechanical-fallback' && gate.fallback
              ? { mechanicalFallback: gate.fallback }
              : {}),
            ...provenanceFields,
            note:
              (!ok
                ? 'Failed to reach the session TUI host socket; try again.'
                : 'Carry-respawn queued — when this turn ends the host cuts this process at the clean boundary and respawns your successor with the deterministic carry document as launch context; it resumes automatically. Wrap up now and stop.') +
              staleNote +
              openQuestionNote,
          }),
        },
      ],
    };
  },
});
