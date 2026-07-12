/**
 * scheduler:get_next — the bee's spec-driven self-select (hybrid-bee-scheduler-work-stealing-2026-06-22).
 *
 * The bee calls get_next; the resolver loads the bee's Queen-issued claim spec (mig 372
 * bee_claim_specs; DEFAULT_CLAIM_SPEC when none) and atomically claims the single next eligible
 * work-item: the GLOBAL FLOORS (ready/blocking, lease, admission, swarm-affinity, dedup) AND the
 * spec's view.filter, ordered by the spec's rank, FOR UPDATE SKIP LOCKED. The spec can only
 * narrow + reorder within the floors (D-002); it can never claim a blocked/taken item.
 *
 * The richer sibling of work_items:claim_next (which is plain oldest-first, spec-blind): here the
 * Queen's scheduling judgment, expressed as the bee's spec, decides WHICH item; pickup stays the
 * bee's (self-selection, the blackboard result).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getNextForBee, resolveClaimSpecWorkspace } from '../../scheduler/claim-spec-store';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';
import { matchRoutingGateHint } from '../../routing-gate-hints';

/**
 * P-006/P-007 (composable-event-awaits-2026-07-11): the idle-puller recipe, delivered at
 * the exact moment it applies — an EMPTY pull. Retires the ~60s idle re-poll cadence:
 * park on ONE await over the canonical `work-item:claimable` key (P-007 dual-emit — it
 * fires on every created-unclaimed / claim-released / last-blocker-cleared transition,
 * collapsing the 3-leaf composed any-spec this recipe originally taught; payload carries
 * {id,kind,severity,harness,title,state,reason} so `payload_filter` narrows it to your
 * claim spec's view), with the ~30-min on_timeout 'wake' as the missed-emit backstop.
 * The wake is a HINT, never a claim — get_next stays the single authoritative claim path,
 * so a spurious/racing wake costs one cheap re-miss, never a double-claim.
 * Exported for the recurrence-guard pin test (idle-loop-recipe-pin.test.ts).
 */
export const IDLE_PULL_MISS_ADVICE =
  'Idle recipe (composable-event-awaits P-006/P-007): do NOT re-poll on a timer — register ONE await and END YOUR TURN: ' +
  'events:await { event: "work-item:claimable", payload_filter: { harness: { eq: "<your-harness>" } } /* narrow to your claim spec\'s view */, timeout_sec: 1800 } ' +
  '— work-item:claimable fires on every created-unclaimed / claim-released / unblocked transition; the ~30-min on_timeout "wake" is the missed-emit backstop. ' +
  'The wake is a HINT that work may exist, never a claim: scheduler:get_next stays the AUTHORITATIVE claim on the wake turn; ' +
  'if it misses again, re-register the same await and end your turn again.';

export default defineTool({
  name: 'scheduler:get_next',
  profile: 'engineer',
  description:
    'Self-select via your claim SPEC (issued by your queen or fleet leader): atomically claim the next eligible work-item — the global floors (ready/blocking, lease, admission, dedup) AND your spec.view.filter, ordered by spec.rank, SKIP LOCKED. No spec set ⇒ default ordering (== work_items:claim_next) + an advisory `warning` (EI-8579). Returns the claimed item + the spec revision that selected it, or null.',
  guidance: {
    when: 'You are a SELF-PULLING agent picking up your next item — a coding-pot cup (role="cup"), or an su fleet MEMBER pulling its lane (su-loop-capability-parity). Call this instead of scanning the raw frontier or self-prioritizing: scheduling is your Mug\'s / fleet leader\'s judgment expressed as your claim spec; the pickup is yours. A claim-spec self-puller is a cup or an su fleet member, NOT a coding-factory pipeline role (see notWhen).',
    notWhen:
      'You are a coding-FACTORY pipeline role (scoper/architect/worker/validator/…): you are PUSHED a FEATURE_ID by the orchestrator spine and do NOT self-pull — never call get_next. Claiming a SPECIFIC item by id — that is work_items:claim. Plain oldest-first self-select with NO per-agent spec — work_items:claim_next.',
    chaining:
      'scheduler:get_next → work_items:set_state (progress) → work_items:release. Your queen or fleet leader re-steers you via scheduler:set_claim_spec (the spec revision bumps; you pick it up on your next get_next). A MISS returns the idle recipe: park on ONE events:await (work-item:claimable) — never a timer re-poll.',
    seeAlso: [
      'work_items:claim_next (plain oldest-first self-select, no spec)',
      'work_items:claim (claim a SPECIFIC item by id)',
      'scheduler:set_claim_spec (the spec your queen or fleet leader steers you with)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
    heldPaths: z
      .array(z.string())
      .max(500)
      .optional()
      .describe('paths you already hold open — the affinity rank-term input (default: none)'),
    // WI-1912: clamped to the claimable allowlist — a free-string `states` let a caller
    // widen past the resolver-owned floors (a member passed ['todo','open','blocked'] and
    // pulled a leader-triage-only blocked item). The claim-spec validator rejects a
    // `blocked` filter TERM for exactly this reason (D-002); the arg gets the same wall.
    states: z
      .array(z.enum(CLAIM_STATES_ALLOWLIST as unknown as [string, ...string[]]))
      .max(20)
      .optional()
      .describe(
        "claimable states — subset of ['todo','open','failing'] (default ['todo']). 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
      ),
    rigAvailable: z
      .boolean()
      .optional()
      .describe(
        'WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded — a single-box caller cannot execute them anyway.',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // SCHEDULER_SPEC_CLAIM kill-switch (default ON; fail-open): OFF ⇒ ignore the bee's stored
    // spec and claim by the DEFAULT ordering (a no-breakage degrade to claim_next behavior).
    const specOn = await getFlag(FLAGS.SCHEDULER_SPEC_CLAIM, ident.ownerId).catch(() => true);
    const res = await getNextForBee({
      cupId: ident.ownerId,
      // WI-1564: MUST match the partition scheduler:set_claim_spec writes
      // (same resolveClaimSpecWorkspace helper) — a reader left on 'default'
      // while the queen writes the workspace partition (or a federated spec
      // arrives under the booted workspace) silently falls back to
      // DEFAULT_CLAIM_SPEC and the steer never lands.
      workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      harness: args.harness,
      heldPaths: args.heldPaths,
      states: args.states,
      rigAvailable: args.rigAvailable,
      ignoreStoredSpec: !specOn,
      // P-006 (fleet-leader-frictions-six-improvements-2026-07-10, WI-3763): this is
      // THE live fleet-member self-pull surface — a miss here is the real "claim-spec
      // view is empty" signal a fleet leader wants pushed, so opt in.
      checkIdleDrainOnMiss: true,
    });
    // EI-8579: a self-puller with NEITHER a per-bee NOR an inherited fleet spec resolves to
    // DEFAULT_CLAIM_SPEC (plain oldest-first) — it can silently draw owner-deferred work
    // (a paused/de-scoped category) a curated spec would have excluded. Advisory only (the
    // claim already happened): nudge the caller to set its own spec, same non-blocking
    // posture as set_claim_spec's EI-6079 wakeability warning.
    const warning =
      res && res.specSource === 'default'
        ? 'You have no per-bee or fleet claim spec — this claim used plain oldest-first DEFAULT_CLAIM_SPEC, which can hand you owner-deferred work (e.g. a paused/de-scoped category). Consider scheduler:set_claim_spec {cupId: you} to scope your own pulls.'
        : undefined;
    // EI-8809 (routing-gate hint at dispatch): most items are already stamped
    // payload.routingHint at creation (work_items:create / plans:promote); this is
    // the render-time FALLBACK for an item created before that wiring landed.
    // Hint only — never blocks, never overrides a stamped value.
    let routingHint: unknown;
    if (res?.workItem) {
      const wi = res.workItem as { title?: string; summary?: string; payload?: unknown };
      const existing =
        wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
          ? (wi.payload as Record<string, unknown>).routingHint
          : undefined;
      routingHint = existing ?? matchRoutingGateHint(wi.title, wi.summary) ?? undefined;
    }
    // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
    // D-006): on a hit, piggyback a targeted memory recall for the claimed
    // item — deadline-bounded, epoch-deduped (port 'claim'), never-throws.
    // This is THE live fleet-member self-pull surface, so it's the port that
    // matters most. Dynamic import keeps the memory chain off the static graph.
    let memory: string | null = null;
    if (res?.workItem) {
      const wi = res.workItem as { id?: string; title?: string; summary?: string; harness?: string | null };
      memory = await import('../../memory/claim-port')
        .then((m) => m.buildClaimRecallBlock({ sessionId: ident.ownerId, workspaceId: ident.workspaceId, items: [wi] }))
        .catch(() => null);
    }
    // WI-4413: a MISS must explain itself. `work_items:claim_next` has run diagnoseClaimNextMiss
    // on a miss since EI-5803 — but THIS path (the one every fleet member self-pulls through, and
    // the one a leader's claim spec drives) returned a static, floor-blind string. Live cost
    // (bug-drain-nonp2p 2026-07-12): three consecutive leader tranches were 100% floored, by three
    // DIFFERENT floors, and each took a manual payload dig to find while members idled.
    // FAILS SOFT: any error here degrades to exactly the old static message — a diagnosis must
    // never be able to break the claim path it is only annotating.
    const missDiagnosis = res
      ? { error: '' as string, diagnosis: undefined, floors: undefined }
      : await buildMissDiagnosis({
          ownerId: ident.ownerId,
          workspaceId: ident.workspaceId,
          harness: args.harness,
          states: args.states,
          rigAvailable: args.rigAvailable,
        });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            res
              ? {
                  ok: true,
                  workItem: res.workItem,
                  claimedUnder: res.claimedUnder,
                  ...(warning ? { warning } : {}),
                  ...(routingHint ? { routingHint } : {}),
                  ...(memory ? { memory } : {}),
                }
              : {
                  ok: false,
                  error: missDiagnosis.error,
                  // WI-4413: the miss now EXPLAINS itself — aggregate POOL/READY split, plus
                  // (when the spec names ids) the exact floor refusing each one.
                  ...(missDiagnosis.diagnosis ? { diagnosis: missDiagnosis.diagnosis } : {}),
                  ...(missDiagnosis.floors ? { floors: missDiagnosis.floors } : {}),
                  // P-006: teach the composed-await idle recipe exactly where the idle
                  // moment happens, instead of leaving the caller to a 60s re-poll.
                  advice: IDLE_PULL_MISS_ADVICE,
                },
          ),
        },
      ],
    };
  },
});
