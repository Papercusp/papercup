/**
 * work_items:claim — Claimable (D-003). Assigns the work-item to an agent
 * (feature-family → taken_by; issue-family → assignee) and subscribes the claimer.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ id, assignee? }), MANY for the SAME assignee (ids:[…] + assignee?), or MANY
 * heterogeneous (items:[{ id, assignee?, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error… }], counts }. Each result self-describes its id; a
 * claim_conflict on one item never fails the rest (top-level ok = "the batch ran",
 * counts.failed is the truth — D-005). The claim lifecycle emit fires per claimed
 * item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, SUPERUSER_FALLBACK_CLIENT_ID, isEphemeralMcpCallIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { shapeWorkItemWriteEcho } from './write-echo-shape';

interface ClaimItem {
  id: string;
  assignee?: string;
  harness?: string;
}

/**
 * Claim ONE item, returning the self-describing result. On the compare-and-claim
 * loss, re-read + classify (EI-2197) so the agent gets an accurate, actionable
 * error (claim_conflict + holder, not_found, or not_claimable) rather than a
 * phantom "not found".
 */
async function claimOne(itRaw: ClaimItem, claimerDefault: string): Promise<BulkItemResult> {
  // EI-9274: a literal `'self'` assignee is treated identically to an OMITTED one
  // (resolved to the caller) — including for the implicit-identity guards below, so
  // `assignee: 'self'` under a loopback/ephemeral identity is refused the same way an
  // omitted assignee would be, instead of bypassing the guard and silently orphaning
  // the claim under an unmatchable literal "self" ownerId (previously stored verbatim —
  // WI-3881).
  const it: ClaimItem = { ...itRaw, assignee: itRaw.assignee === 'self' ? undefined : itRaw.assignee };
  if (!it.assignee && claimerDefault === SUPERUSER_FALLBACK_CLIENT_ID) {
    return {
      ok: false,
      id: it.id,
      error: 'missing_client_identity',
      hint:
        'Implicit work-item claims require a real per-session or spawn owner. This request arrived as the shared su-loopback fallback, so it was refused before mutating the claim. Reconnect with a client identity or pass an explicit assignee.',
    };
  }
  // EI-8509: refuse an IMPLICIT claim under scripts/mcp-call.mjs's auto-generated
  // fallback identity (`mcp-call-<pid>`) — a one-shot stateless call with zero
  // liveness behind it, never a real spawned cup. Left unguarded, this is exactly
  // how "placed" work silently rots with nothing ever executing it (fleet_assignments
  // showed 4 such claims: assignee set, lastProgressAt/heartbeatAt null, sessionState
  // 'ended'). An explicit `assignee` (naming a real agent on purpose) still passes.
  if (!it.assignee && isEphemeralMcpCallIdentity(claimerDefault)) {
    return {
      ok: false,
      id: it.id,
      error: 'ephemeral_mcp_call_identity',
      hint:
        'Refused: this call arrived under scripts/mcp-call.mjs\'s auto-generated fallback identity (mcp-call-<pid>), a one-shot process with no liveness/heartbeat and no fleet cup behind it — claiming here would silently "place" work that nothing executes (EI-8509). Spawn a real cup (fleet:spawn / bee:spawn) and let IT claim, or pass an explicit `assignee` naming the real agent that will do the work.',
    };
  }
  const claimer = it.assignee ?? claimerDefault;
  const workItem = await claimWorkItem(it.id, claimer, { harness: it.harness });
  if (workItem) return { ok: true, id: it.id, workItem };
  // claimWorkItem returns a bare null for THREE distinct outcomes — re-read + classify.
  const current = await getWorkItem(it.id, it.harness);
  const failure = classifyClaimFailure(current, claimer);
  if (failure.reason === 'not_found') {
    return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };
  }
  if (failure.reason === 'conflict') {
    return {
      ok: false,
      id: it.id,
      error: 'claim_conflict',
      holder: failure.holder,
      workItem: current,
      hint: `Already claimed by ${failure.holder} — the item exists (get/observe/comment/complete resolve it). Coordinate with the holder via coord:send, or pick another item; if that agent is dead, the stale-claim reclaim lane frees it. Do not blind-retry with a different harness.`,
    };
  }
  return {
    ok: false,
    id: it.id,
    error: 'not_claimable',
    workItem: current,
    hint: 'Item exists but the claim was refused by a trust/admission gate, or it was released between the claim and this re-read — re-check with work_items:get / work_items:observe.',
  };
}

export default defineTool({
  name: 'work_items:claim',
  profile: 'engineer',
  description:
    'Claim one OR many work-items (assign to yourself, or to `assignee`). Claiming a feature sets taken_by; an issue sets assignee. Single: { id, assignee? }. Many same assignee: { ids:[…], assignee? }. Many heterogeneous: items:[{ id, assignee?, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error, holder? }], counts } — correlate by id; a claim_conflict on one item never fails the rest.',
  guidance: {
    when: 'You are starting work on work-item(s) — claim so peers do not duplicate. Claim a swath at once via { ids:[…] }.',
    notWhen: 'A per-item `claim_conflict` means a LIVE peer holds it — coordinate with the `holder` (coord:send) or pick another item; do not blind-retry. (If the holder is dead, the stale-claim reclaim lane frees it.)',
    chaining:
      'work_items:list → work_items:claim → work_items:set_state → work_items:release/close. There is no separate work_items:heartbeat — ANY papercusp-su tool call already refreshes your liveness (dispatch-heartbeat beats coord_presence on every settled dispatch), which is what the stale-claim reaper checks before reclaiming a held item. The gap is a long stretch of PURELY-LOCAL tool use (Bash/Read/vitest with zero papercusp-su calls) during a >10-15min single-claim investigation (EI-6772) — call work_items:checkpoint { id, checkpoint } partway through (it doubles as your progress note AND a liveness pulse) rather than going silent on the platform for the whole investigation.',
    seeAlso: [
      'work_items:claim_next (self-select the next claimable item instead of naming an id)',
      'work_items:observe (check claimability before taking)',
      'work_items:release (drop the claim if you stop working it)',
      'work_items:checkpoint (periodic progress note + liveness pulse during a long claim)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-claim shorthand: the work-item id'),
      assignee: z.string().max(120).optional().describe('default: you (also resolves the literal "self" to you). Applies to the inline id / every id in `ids`.'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('claim MANY items for the same `assignee` (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            assignee: z.string().max(120).optional(),
            harness: z.string().max(80).optional(),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('claim many work-items at once — each { id, assignee?, harness? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  // context-trimming-tiers P-025 (write-echo diet): trimmed/standard sessions
  // get a compact workItem ref per result instead of the full echoed row;
  // outcome fields (ok/error/holder/hint/reflect) pass through verbatim —
  // see write-echo-shape.ts.
  shape: {
    standard: (data) => shapeWorkItemWriteEcho(data, 'standard'),
    trimmed: (data) => shapeWorkItemWriteEcho(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list: ClaimItem[] = args.items?.length
      ? args.items.map((it) => ({ id: it.id, assignee: it.assignee ?? args.assignee, harness: it.harness ?? args.harness }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, assignee: args.assignee, harness: args.harness }))
        : [{ id: args.id as string, assignee: args.assignee, harness: args.harness }];
    const env = await runBulk(list, (it) => claimOne(it, ident.ownerId), { keyOf: (it) => ({ id: it.id }) });
    // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
    // D-006): piggyback a targeted memory recall for the just-claimed item(s)
    // on the response — deadline-bounded, epoch-deduped (port 'claim'),
    // never-throws (dynamic import keeps the memory chain off this module's
    // static graph — see _bulk.ts's ESM-cycle note).
    const claimedItems = env.results
      .filter((r) => r.ok && r.workItem != null)
      .map((r) => r.workItem as { id?: string; title?: string; summary?: string; harness?: string | null });
    const memory = claimedItems.length
      ? await import('../../memory/claim-port')
          .then((m) =>
            m.buildClaimRecallBlock({
              sessionId: ident.ownerId,
              workspaceId: ident.workspaceId,
              items: claimedItems,
            }),
          )
          .catch(() => null)
      : null;
    return bulkContent(memory ? { ...env, memory } : env);
  },
});
