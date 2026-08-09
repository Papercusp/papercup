/**
 * mode:set — enter/exit an official session mode, for yourself OR a peer
 * (modes-and-intake-ux-2026-07-05 P-006; D-003 guardrails, D-006 axes).
 *
 * Modes are first-class data (harness_shared.agent_modes), not prompt prose:
 * peers see your modes in coord:presence / coord:orient, and every transition
 * is audited (agent_mode_changes). Semantics enforced by the store:
 *   - AXES: same-axis modes auto-switch (setting drain clears ideate — both
 *     recorded); cross-axis modes stack (auto + ideate is the canonical pair).
 *   - OWNER-STICKY (D-003): a mode armed with ownerDirected (the human owner
 *     explicitly instructed it) cannot be overridden by a PEER — the attempt
 *     is refused and DOWNGRADED to a request message the target/owner sees.
 *   - PEER-SET delivery: reason is mandatory; the target gets a coord message
 *     carrying the reason AND the mode's full contract, and the change takes
 *     effect at ITS next turn boundary (coord:orient re-injects active
 *     contracts each wake — nothing changes mid-turn).
 *
 * On a SELF-set the response carries the full mode contract (P-008: the
 * always-present prompt holds only the one-line index; the contract loads at
 * activation — read it NOW, it is binding while the mode is on).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, ADMIN_COORD_UI_OWNER } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { modeById, MODES, modeImpliesAutonomy } from '../../modes/registry';
import { setMode } from '../../modes/store';
import { assertFact, retractFact, FACT_BODY_MAX_CHARS } from '../../agent-facts/store';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';
import { getLoopStatus } from '../../harness/routines/loop';

const MODE_IDS = MODES.map((m) => m.id);

/**
 * Key prefix for the standing fact a mode's `instructions` are asserted under
 * (session-chat-popup-timestamps-and-modes-2026-08-09 D-002).
 *
 * One key PER MODE, not one per call: the fact is an UPSERT target, so
 * re-scoping a running drain overwrites the standing instruction rather than
 * stacking a second one beside it — and turning the mode off has exactly one
 * key to retract.
 */
export const MODE_INSTRUCTIONS_KEY_PREFIX = 'mode-instructions:';

export function modeInstructionsFactKey(modeId: string): string {
  return `${MODE_INSTRUCTIONS_KEY_PREFIX}${modeId}`;
}

/**
 * The fact body. OPERATIVE CLAUSE FIRST, provenance last — deliberately, because
 * the store hard-clips at FACT_BODY_MAX_CHARS and the caller's `instructions`
 * may be longer than everything else here combined. Clipping the "who set it"
 * tail costs an anchor; clipping the instruction itself would silently change
 * what the agent is told to do.
 */
export function renderModeInstructionsFact(opts: {
  modeId: string;
  instructions: string;
  ownerDirected: boolean;
  setBy: string;
}): string {
  const who = opts.ownerDirected ? 'the owner' : opts.setBy;
  return (
    `${opts.modeId.toUpperCase()} SCOPE — while '${opts.modeId}' is on, obey this verbatim: ` +
    `${opts.instructions.trim()} ` +
    `(set by ${who}; retracted when the mode is turned off)`
  );
}

/**
 * WI-6949 — the wake-source guard, fired at the ACTION-POINT that creates the hazard.
 *
 * An autonomy mode is an AUTHORIZATION posture ("act, don't ask"); it is NOT a wake
 * source. The engine loop is. An agent that registers AUTO while an interactive owner is
 * present is safe only for as long as the owner keeps replying — the moment they walk
 * away, that agent's only wake source silently disappears and the next turn it ends is
 * its last. A carry-respawn does NOT rescue it: a respawn restores CONTEXT, not a TURN.
 *
 * The playbook already carries a well-written "end-of-turn test" for exactly this
 * (operating-modes-policy.ts), and it did not prevent the 2026-08-02 incident, for two
 * structural reasons worth recording here because they generalize:
 *
 *   1. That rule is anchored to a CESSATION, not an action. Every other rule in the
 *      playbook hangs off something you DO, so something prompts the check. Nothing
 *      prompts you at "about to end the turn" — there is no tool call there.
 *   2. The hazard is created at a TRANSITION nothing marks (owner-present →
 *      owner-absent), but the rule is evaluated at the turn boundary — by which point
 *      dozens of correctly-ended interactive turns have established the opposite prior.
 *
 * So the check belongs HERE: `mode:set` IS the transition. This returns a warning rather
 * than refusing, because a genuinely one-shot AUTO task ("do this now, finish it this
 * turn") needs no loop and must not be blocked.
 */
export function wakeSourceWarning(opts: {
  modeId: string;
  axis: string;
  enabled: boolean;
  loopActive: boolean;
}): string | null {
  if (!opts.enabled) return null;
  // The autonomy axis covers auto + cold-auto; an overlay may also IMPLY auto
  // (drain, goal). Both readings live in the registry — never re-spell the list.
  const impliesAutonomy = opts.axis === 'autonomy' || modeImpliesAutonomy(opts.modeId);
  if (!impliesAutonomy || opts.loopActive) return null;
  return (
    `⚠ NO WAKE SOURCE. '${opts.modeId}' is an AUTHORIZATION posture — it does not make you run. ` +
    'The engine loop is the recurrence mechanism, and you have none armed, so an interactive owner ' +
    'is currently your ONLY wake source. The moment they stop replying, the next turn you end is ' +
    'your last: nothing re-wakes you, and a carry-respawn restores CONTEXT, not a TURN. ' +
    'If this mode is meant to outlive the owner sitting there — which is what "keep going" / ' +
    '"do this from start to finish" / any open-ended directive means — arm the recurrence NOW: ' +
    'loop:arm { intervalSec: 60, goal, workItem }. Ignore this ONLY if you will genuinely finish ' +
    'inside this turn.'
  );
}

/**
 * WI-7302 part 2 — the SYMMETRIC case of `wakeSourceWarning` above.
 *
 * That one fires when you are ABOUT to lose your wake source (registering an
 * autonomy mode with no loop armed). It has no counterpart for the state that
 * actually stranded a fleet on 2026-08-02: you HAD a wake source, and it is
 * gone now. Nothing re-checks after the transition, so the loss is silent.
 *
 * Two design points, both load-bearing:
 *
 *  1. It keys on `wakeSource === 'none'`, NOT on `!loop.active`. The loop-only
 *     reading is the tempting one — it is what the sibling above uses — and it
 *     is WRONG here: a session correctly parked on `events:await
 *     { work-item:claimable }` has no armed loop and is still perfectly
 *     wakeable. The member contract explicitly PRESCRIBES that park, so a
 *     loop-only check would cry wolf precisely at sanctioned behaviour, and a
 *     warning that fires on correct behaviour is worse than no warning.
 *
 *  2. The registered MODE is what makes this actionable, and it is why no
 *     tombstone is needed to answer "did I once have a loop?". The useful
 *     question is not what you HAD, it is what you are SUPPOSED to have — and
 *     an `auto`/`drain` registration is exactly the durable statement that this
 *     session intends to outlive its owner. Modes live in their own store, so a
 *     wipe of `routines` does not take them with it.
 *
 * UNKNOWN (`wakeSource` absent — the leg degraded) returns null: a failed query
 * must never be able to tell a healthy session that it is about to die.
 */
export function wakeSourceLostWarning(opts: {
  modes: readonly string[];
  wakeSource?: 'loop' | 'event' | 'none';
}): string | null {
  if (opts.wakeSource !== 'none') return null;
  const autonomy = opts.modes.filter((m) => modeImpliesAutonomy(m));
  if (autonomy.length === 0) return null;
  return (
    `⚠ WAKE SOURCE GONE. You are registered '${autonomy.join("' + '")}' — an autonomy posture that is ` +
    'meant to outlive an owner sitting there — but NOTHING will wake you unprompted: no armed engine ' +
    'loop, and no standing events:await. The next turn you end is your last, and a carry-respawn ' +
    'restores CONTEXT, not a TURN. Re-arm now: loop:arm { intervalSec, goal } — or, if you are ' +
    'deliberately waiting on a condition, park properly with events:await so something can wake you. ' +
    'If you are genuinely finishing inside this turn, mode:set { enabled: false } instead of leaving ' +
    'a mode registered on a session that cannot act on it.'
  );
}

export default defineTool({
  name: 'mode:set',
  profile: 'engineer',
  description:
    'Enter/exit an official session mode (auto | cold-auto | ideate | drain | grade | goal) for yourself or a peer. ' +
    '{ mode, reason, enabled?, agent?, ownerDirected? }. Same-axis modes AUTO-SWITCH (result carries switchedFrom); ' +
    'cross-axis modes stack. Peer-set: reason is delivered to the target with the mode contract; an owner-directed ' +
    'incumbent REFUSES a peer override (stickyConflict:true — downgraded to a request message). Self-set returns the ' +
    'full binding contract — read it. Audited in agent_mode_changes.',
  guidance: {
    when:
      'The user (or your judgment under AUTO) puts the session in a mode — "auto mode", "ideate", "drain the backlog", ' +
      '"grade X" — or you need to redirect a peer\'s operating posture with a reason they will see. Pass ' +
      'ownerDirected:true ONLY when the human owner explicitly instructed this mode — it arms the sticky guard peers cannot override.',
    notWhen:
      'Transient per-task instructions that end with the turn — modes are standing session state. Never mode:set a peer ' +
      'to dodge coordination (the reason is delivered and audited); never pass ownerDirected on your own initiative.',
    chaining:
      'mode:set → read the returned contract (self) · coord:orient re-injects active contracts each wake · mode:get { agent } ' +
      'to inspect anyone · exiting: mode:set { mode, enabled:false, reason }. A stickyConflict result means the incumbent is ' +
      'owner-directed: your reason was delivered as a REQUEST — do not retry, wait for the target/owner.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z.enum(MODE_IDS as [string, ...string[]]).describe('the mode id'),
    reason: z.string().min(1).max(2000).describe('why — MANDATORY; delivered to a peer target verbatim'),
    instructions: z
      .string()
      .max(4000)
      .optional()
      .describe(
        `SCOPE INSTRUCTIONS that must survive compaction — e.g. drain "all bugs except the ones related to the p2p features". Delivered with the mode change AND asserted as a standing fact on the target (key '${MODE_INSTRUCTIONS_KEY_PREFIX}<mode>'), so it is re-injected VERBATIM on every wake until the mode is turned off, which retracts it. Clipped at ${FACT_BODY_MAX_CHARS} chars. Use \`reason\` for WHY the mode changed; use this for WHAT the mode is scoped to.`,
      ),
    enabled: z.boolean().optional().describe('default true; false ⇒ exit the mode'),
    agent: z.string().max(120).optional().describe('target ownerId (exact, e.g. su-…); omit for yourself'),
    ownerDirected: z
      .boolean()
      .optional()
      .describe('the human owner explicitly instructed this mode (self-set only) — arms the owner-sticky guard'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const target = args.agent?.trim() || ident.ownerId;
    const isSelf = target === ident.ownerId;
    const enabled = args.enabled !== false;
    const def = modeById(args.mode);
    if (!def) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `unknown mode '${args.mode}'` }) }] };

    // The admin coord/mode UI (P-003/P-004) acts on the owner's behalf when it
    // sets a mode on the agent session the human is chatting with — a PEER-set
    // (setBy !== ownerId) that nonetheless carries verified owner authority.
    // resolveAgentIdentity already ties this ownerId to the admin route's
    // synthesized `?client=` (never client-suppliable from an ordinary agent
    // context), so this is a tool-layer-VERIFIED check, not a trusted claim.
    const callerIsOwnerAuthority = ident.ownerId === ADMIN_COORD_UI_OWNER;
    const ownerAuthorized = isSelf || callerIsOwnerAuthority;

    const res = await setMode({
      workspaceId: ident.workspaceId ?? 'default',
      ownerId: target,
      modeId: def.id,
      enabled,
      reason: args.reason,
      setBy: ident.ownerId,
      ownerDirected: args.ownerDirected,
      callerIsOwnerAuthority,
    });
    const control = res.ok && !res.noop
      ? await refreshControlAnchorAfterMutation({
          ownerId: target,
          workspaceId: ident.workspaceId ?? 'default',
          origin: args.ownerDirected && ownerAuthorized ? 'owner' : 'agent',
          actorId: ident.ownerId,
          source: 'mode:set',
          ownerDirected: Boolean(args.ownerDirected && ownerAuthorized),
        })
      : null;

    // WI-6949: an applied autonomy mode with no armed loop leaves the TARGET with no
    // wake source. Read the target's loop (not the caller's) so a peer-set warns about
    // the agent that will actually go inert. Fail-soft — a loop-read hiccup must never
    // fail an applied mode change, so a read error simply suppresses the advisory.
    let wakeWarning: string | null = null;
    if (res.ok && !res.noop && enabled) {
      try {
        const loop = await getLoopStatus(target);
        wakeWarning = wakeSourceWarning({
          modeId: def.id,
          axis: def.axis,
          enabled,
          loopActive: loop?.active === true,
        });
      } catch { /* fail-soft */ }
    }

    // Peer-set: deliver the why (+ contract on enable) — or the downgraded
    // REQUEST when the owner-sticky guard refused the write. Fail-soft: a
    // delivery hiccup never rolls back an applied mode change.
    if (!isSelf && (res.ok || res.stickyConflict)) {
      const verb = !res.ok ? 'REQUESTS (owner-sticky refused)' : enabled ? 'set you to' : 'cleared';
      try {
        await sendMessage(ident, {
          to: [target],
          summary: `mode: ${ident.ownerId} ${verb} '${def.id}' — ${args.reason.slice(0, 140)}`,
          body:
            `${ident.ownerId} ${verb} mode '${def.id}' (${def.axis} axis).\nReason: ${args.reason}` +
            (res.ok && res.switchedFrom ? `\nAuto-switched from same-axis mode '${res.switchedFrom}'.` : '') +
            (res.ok && enabled ? `\nEffective from your NEXT turn. Binding contract:\n\n${def.contract}` : '') +
            (wakeWarning ? `\n\n${wakeWarning}` : ''),
          extra: { mode_change: { mode: def.id, enabled, applied: res.ok === true, stickyConflict: res.stickyConflict === true, by: ident.ownerId } },
        });
      } catch { /* fail-soft */ }

      /* WAKE the target — session-chat-popup-timestamps-and-modes-2026-08-09
         P-004. [owner 2026-08-09] "chanfing the mode didnt send a message to the
         [agent] shouldnt mode changes also automatically message the agent?"

         The message above was ALREADY being sent; what was missing is that
         `sendMessage` is the raw append-to-outbox seam and does not wake anyone
         (the wake lives one layer up, in coord:send's own tool). So a mode set
         on a LIVE, working agent sat unread in its inbox until that agent
         happened to take another turn — which, for an agent parked on an
         `events:await`, can be a very long time. The owner flips a posture and
         nothing observable happens, which is indistinguishable from the write
         having failed.

         A mode change is precisely the kind of message that must not wait for
         the next turn: it CHANGES THE CONTRACT the agent is operating under, and
         every turn it takes before reading it is a turn taken under the old one.

         Fail-soft, and deliberately AFTER the applied write: waking is a
         courtesy on top of a durable inbox row, so a wake failure must never
         roll back or fail an applied mode change. A miss simply degrades to the
         pre-existing behavior — the agent reads it on its next turn. */
      try {
        const { wakeRecipients } = await import('../coordination/inbox-wake');
        await wakeRecipients([target], {
          summary: `mode '${def.id}' ${enabled ? 'set' : 'cleared'} by ${ident.ownerId}`,
          source: 'mode:set',
          workspaceId: ident.workspaceId ?? undefined,
        });
      } catch { /* fail-soft — the durable inbox row already landed above */ }
    }

    const payload: Record<string, unknown> = {
      ok: res.ok,
      mode: def.id,
      axis: def.axis,
      target,
      enabled,
      noop: res.noop ?? false,
      switchedFrom: res.switchedFrom ?? null,
      stickyConflict: res.stickyConflict ?? false,
      ...(res.stickyConflict ? { note: 'incumbent is owner-directed; your reason was delivered as a REQUEST — do not retry' } : {}),
      ...(res.ok && enabled && isSelf ? { contract: def.contract } : {}),
      ...(wakeWarning ? { wakeSource: 'owner-only', wakeSourceWarning: wakeWarning } : {}),
      ...(control ? { controlGeneration: control.generation } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
