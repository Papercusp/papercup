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
import { estimateContextWindowForOwner, resolveModelSpecForOwner } from '../../compaction-usage';
import { modelWindowForSpec } from '../../agent-config-constants';
import {
  staleCheckpointWarnings,
  STALE_CHECKPOINT_WARN_MS,
  type CheckpointFlushWarning,
} from '../../enforcement-gate';
import { runFlushGate } from '../../enforcement-gate-io';
import { markRespawnExpected } from '../../carry-respawn-marker';
import { readPriorRespawnOutcome, priorRespawnNote } from '../../carry-respawn-outcome';
import { bumpSessionEpoch } from '../../memory/session-epoch-ledger';
import { getOrgPg } from '@papercusp/db-org';
import { getLoopStatus } from '../../harness/routines/loop';
import { getLoopCarryNoteWithMeta } from '../../carry-note';

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
 * EI-18686525818431054: `injectIntoHost`'s DEFAULT client-side socket timeout
 * (2000ms) is sized for an ordinary wake `turn` — the psu-pty-host acks
 * 'accepted' immediately after early validation (payload/ownerId/coalesce
 * checks), before ever entering the human-idle + agent-busy GATES, which can
 * legitimately run up to `TURN_INJECT_BUSY_CAP_MS` (production default 180s)
 * — doubled for a carry-respawn's one re-arm retry (psu-pty-host.mjs
 * `makeCarryRearmController`) — before the actual write/recycle proceeds as a
 * detached background continuation. A HOST RUNNING CODE FROM BEFORE THAT
 * ack-early fix landed (WI-5872 follow-up #2, EI-18679050054551625) instead
 * awaits the FULL gated pipeline before writing anything back — and since a
 * psu-pty-host process is never restarted by a carry-respawn (only its CHILD
 * CLI is; the host persists for the life of the psu session), a session whose
 * host predates that fix hits the 2000ms client timeout on every single
 * `session:request-compaction` call: "Failed to reach the session TUI host
 * socket" — the ONE sanctioned context-shedding path, failing exactly when a
 * long-running session needs it most (this is literally that filing's
 * reproduction). A carry-respawn is inherently latency-INSENSITIVE from the
 * caller's point of view — the agent is ending its turn regardless — so
 * there is no cost to waiting substantially longer here: on a FIXED host the
 * ack still returns in milliseconds; on a STALE pre-fix host (or one merely
 * scheduling-delayed on a loaded box) this gives the full gated pipeline room
 * to actually complete and report truthfully instead of timing out on a
 * false negative. Sized comfortably past the doubled busy-gate cap
 * (2 * 180_000 = 360_000ms) with wide margin for host scheduling jitter.
 */
const CARRY_RESPAWN_SOCKET_TIMEOUT_MS = 15 * 60_000;

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
      // EI-20211379927723290: an event-resumed Codex loop has no persistent
      // psu-pty host by design. A cold loop already provides the same
      // deterministic boundary on the next settled wake; accept that path only
      // when its durable carry-note exists, so this never discards unflushed
      // state or pretends an unarmed session can respawn itself.
      const loop = await getLoopStatus(identity.ownerId).catch(() => null);
      if (loop?.active && loop.carry === 'cold' && loop.harnessSlug) {
        const carry = await getLoopCarryNoteWithMeta({
          harness: loop.harnessSlug,
          ownerId: identity.ownerId,
          workspaceId: identity.workspaceId ?? undefined,
        });
        if (carry.note) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  respawn: 'cold-loop-settle',
                  note: 'No psu-pty host is required: end this turn now. The armed cold loop will start the next wake in fresh context from the verified loop:checkpoint carry-note.',
                }),
              },
            ],
          };
        }
      }
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
      const observedWindow = await estimateContextWindowForOwner(identity.ownerId);
      if (observedWindow != null) {
        effectiveWindowTokens = observedWindow;
      } else {
        const spec = await resolveModelSpecForOwner(identity.ownerId);
        if (spec) effectiveWindowTokens = modelWindowForSpec(spec);
      }
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
    // EI-19480099650947832: read what happened to this session's PREVIOUS
    // carry-respawn BEFORE injecting this one, so the verdict describes prior
    // history rather than the request we are about to make. `respawn: true` only
    // ever meant "the socket write was accepted" — the host still has to win a
    // busy-gate and can terminally drop the carry, and until now every one of
    // those drops was invisible to the caller (they land in a per-owner JSONL
    // the tool layer never read). Fail-soft by construction: an unreadable log
    // reports `none` and changes nothing.
    const priorRespawn = await readPriorRespawnOutcome(identity.ownerId);
    const ok = await injectIntoHost(
      host.sock,
      {
        mode: 'carry-respawn',
        data: firstPrompt,
        systemPromptAddendum: spec.systemPromptAddendum,
        ownerId: identity.ownerId,
      },
      // EI-18686525818431054: NOT the 2000ms default — see
      // CARRY_RESPAWN_SOCKET_TIMEOUT_MS's doc comment above.
      CARRY_RESPAWN_SOCKET_TIMEOUT_MS,
    );
    // EI-18676518990229124 (session-death-claim-release-2026-07-11 P-002 false
    // positive): the cut we just queued will end THIS process under the SAME
    // ownerId and relaunch it in seconds — the killed child's ordinary
    // SessionEnd/Stop hook must NOT be read as "this owner is confirmed dead"
    // and force-release every work-item lease it holds. Mark the owner
    // "respawn expected" now (only once the respawn is genuinely queued, i.e.
    // the socket write succeeded) so report.ts's P-002 branch skips the
    // release for this transition; a respawn that never lands still frees the
    // owner's claims via the P-001 scheduled backstop (the marker's short TTL).
    // Awaited (WI-6756 follow-on): the mark is a PG row now, not a heap entry —
    // the operator is clustered, so the worker that handles the imminent
    // SessionEnd is usually NOT this one. It must be durably written before the
    // respawn's SessionEnd can race it; markRespawnExpected never throws.
    if (ok) await markRespawnExpected(identity.ownerId);
    // WI-36074 (context-injection P-023): THE MEMORY EPOCH BOUNDARY.
    //
    // The per-session surfaced ledger (memory_session_surfaced) suppresses
    // re-injecting a memory this session has already been shown, on the premise
    // that a WARM session still HAS it in context. `bumpSessionEpoch` is the only
    // thing that clears that suppression, and its whole design is "bump at the
    // moment context is wiped, so the pool becomes injectable again".
    //
    // Until now its ONLY production reach was compact-reprime.ts, called from the
    // session-recovery-brief route, fetched ONLY by the SessionStart hook gated on
    // `source === 'compact'`. psu sessions launch with DISABLE_COMPACT=1 +
    // DISABLE_AUTO_COMPACT=1 (psu-pty-host.mjs, the P-022 cutover), so native
    // compaction NEVER fires and that hook NEVER runs — the P-022 cutover moved the
    // compaction boundary HERE (carry-respawn) and silently orphaned the bump.
    //
    // Measured 2026-08-08 before this fix: last bump ever 2026-08-02 (6 days, 0 in
    // 24h) while ~29 agents ran continuously; 56,734 of 57,154 ledger rows (99.3%)
    // frozen at epoch 0; every one of the 12 most-active sessions of the prior 48h
    // absent from memory_session_epochs entirely. Net effect: every memory ever
    // injected stayed suppressed for the 14-day GC horizon — ACROSS the respawn that
    // wiped the context, i.e. precisely when re-priming matters most. That is the
    // mechanism behind D-071's dedup=42.6% and its zeroed recalls (returned 12 →
    // admitted 0).
    //
    // Fail-soft exactly like markRespawnExpected above: bumpSessionEpoch swallows its
    // own errors and returns null, and a missed bump degrades to the (broken) prior
    // behavior rather than failing the compaction the caller asked for.
    if (ok) {
      try {
        const { sql } = getOrgPg();
        await bumpSessionEpoch(sql, identity.ownerId);
      } catch {
        /* never block the cut on memory hygiene */
      }
    }
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
            // EI-19326331501849713: 'queued', NOT `true`. This field only ever
            // meant "the socket write was accepted" (see the comment at the
            // readPriorRespawnOutcome call above) — the host still has to win the
            // busy gate and can terminally DROP the carry. A BOOLEAN here read as
            // a statement about an OUTCOME, which is exactly what let a dropped
            // respawn pass for a successful one: told `true`, the agent stops
            // managing its own context and waits for a successor that never comes.
            // A string states the intent honestly. It stays TRUTHY, so any existing
            // `if (res.respawn)` is unaffected.
            respawn: ok ? 'queued' : false,
            budgetChars: spec.budgetChars,
            firstPromptSource: spec.firstPrompt ? 'open-owner-message' : 'continuation-note',
            staleCheckpoints,
            openOwnerQuestion,
            priorRespawn,
            ...(gate.verdict === 'mechanical-fallback' && gate.fallback
              ? { mechanicalFallback: gate.fallback }
              : {}),
            ...provenanceFields,
            ...(!ok ? { hostSock: host.sock, hostPid: host.pid } : {}),
            note:
              (!ok
                ? // EI-18686525818431054 ask #3: name the socket path + host pid tried,
                  // so the next diagnosis doesn't have to reverse-engineer it from `ps`
                  // + `find` (this filing's own investigation cost ~6 tool calls on that
                  // alone). `identity.ownerId` is already on the caller's side to compare.
                  `Failed to reach the session TUI host socket (${host.sock}, host pid ${host.pid}) ` +
                  `even after waiting up to ${CARRY_RESPAWN_SOCKET_TIMEOUT_MS}ms; try again. If this ` +
                  'recurs, the host process may predate the ack-early carry-respawn fix (WI-5872 ' +
                  'follow-up #2) — it never restarts on its own (only its child CLI does via ' +
                  'carry-respawn), so a genuinely stale host requires ending this session and ' +
                  'relaunching to pick up a current one.'
                : // EI-19326331501849713: state the QUEUE, never the outcome. The old
                  // wording ("the host cuts this process ... it resumes automatically")
                  // described a cut that had not happened yet as though it had, and
                  // told the agent to stop — so a carry that was then DROPPED left it
                  // waiting for a successor that did not exist, still holding unflushed
                  // state. Name the precondition (pty quiet) and the falsifier (you are
                  // still here) so the failure is self-diagnosing from the agent's side.
                  'Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting.') +
              staleNote +
              openQuestionNote +
              // EI-19480099650947832: only ever emitted on evidence from the
              // host's own event log — silent when the last respawn delivered.
              (ok ? priorRespawnNote(priorRespawn) : ''),
          }),
        },
      ],
    };
  },
});
