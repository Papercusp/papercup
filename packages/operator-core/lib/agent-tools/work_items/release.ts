/**
 * work_items:release — Claimable (D-003). Unassigns the work-item.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): release ONE inline
 * ({ id }), or MANY (ids:[…] / items:[{ id, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error }], counts }. Each result self-describes its id; one not-found
 * item never fails the rest. The plan-item reflect rules (flip the converted plan
 * item back to todo + drop the lease) fire per released item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { releaseWorkItem, setWorkItemClaimHold, getWorkItem, commentWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';
import {
  assessForceRelease,
  forceRefusalHint,
  notifyForceRelease,
  recordForceReleaseAudit,
  type ForceReleaseBasis,
} from './release-force-guard';
import { readWorkItemReleaseRequest, resolveWorkItemReleaseRequest } from '../../work-items-release-request';
import { getWorkItemCheckpoint } from '../../work-item-checkpoint';
import { detectBgJobCheckpointClaim } from '../../checkpoint-bg-job-claim';

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  claimHold: z
    .boolean()
    .optional()
    .describe('per-item claim-hold override (else the batch `claimHold` default)'),
  force: z.boolean().optional().describe('per-item override of the batch `force` default'),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('per-item override of the batch `reason` (required when force clears a peer\'s claim)'),
});

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  description:
    'Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error, holder? }], counts } — correlate by id; a not-found item never fails the rest. Refuses to clear ANOTHER agent\'s live claim (`{ ok:false, error:"not_holder", holder }` per item); `force:true` is a CHECKED override (WI-4198), not a bypass — non-live holder / queen / the holder\'s fleet leader only, requires `reason`, audited + notifies holder and owner (full rules on the `force` arg); anything else refuses with `force_unauthorized`. A voluntary release records a short re-claim cooldown. `claimHold:true` (both families) ALSO durably parks the item out of claim_next/scheduler:get_next self-select (WI-2797) — a park (you + `reason` recorded) that SURVIVES your session ending, unlike a hold_open lease; still claimable by id; `claimHold:false` clears it.',
  guidance: {
    when: 'You claimed work-item(s) but are no longer working them. Add claimHold:true when the item must NOT be opportunistically re-claimed by the next self-selecting agent (a recurring do-not-pick-up ticket) — plain release lets it re-surface immediately.',
    notWhen: 'A per-item `not_holder` means a LIVE peer currently holds it — coordinate with the `holder` (coord:send), do not blind-force: force is for reclaiming a dead/stuck agent\'s item, never for clearing a peer\'s in-flight claim.',
    chaining: 'work_items:claim → … → work_items:release.',
    seeAlso: [
      'work_items:set_state { state:"blocked" } (standalone feature-family park; plan-linked feature items must use plans:set-status because the plan item is the source of truth; issue-family aliases blocked back to open — release { claimHold:true } is the durable self-select exclusion)',
      'work_items:hold_open (hold the item open — stamps held_open_by + blocks non-holder terminal transitions — WITHOUT releasing your claim)',
      'work_items:claim (re-take it later, or claim a held item directly by id — a hold only excludes self-select)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-release shorthand: the work-item id'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('release many work-items at once (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many, each { id, harness?, claimHold? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      claimHold: z
        .boolean()
        .optional()
        .describe(
          'default claim-hold for the inline id / every id in `ids` (both families): true excludes the item from claim_next/scheduler:get_next self-select until cleared; false clears a prior hold.',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'default force for the inline id / every id in `ids`: release even if held by ANOTHER agent. CHECKED override (WI-4198): allowed only when the holder is not live, or you are queen, or you lead the HOLDER\'s fleet — and a cross-holder force requires `reason` and is audited + notifies holder/owner. Default false: refuses with { error:"not_holder", holder } when the caller is not the current holder.',
        ),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          'default reason for the inline id / every id in `ids` — REQUIRED when force clears another agent\'s claim (recorded in the audit row and both notifications); with claimHold:true it is also recorded as the durable park reason.',
        ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, harness: args.harness, claimHold: args.claimHold, force: args.force, reason: args.reason }))
        : [{ id: args.id as string, harness: args.harness, claimHold: args.claimHold, force: args.force, reason: args.reason }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        const force = it.force ?? args.force ?? false;
        // WI-4198: force is a CHECKED override, not a bypass. Before releasing,
        // identify the holder; a cross-holder force must pass the authority/liveness
        // guard, carry a reason, and leave an audit + notification trail.
        let forced: { holder: string; basis: ForceReleaseBasis; reason: string } | undefined;
        // WI-6678: the force path already reads the row — reuse that read for the
        // released/previousAssignee delta below instead of paying a second round-trip.
        let forcedPrior: string | null | undefined;
        if (force) {
          const current = await getWorkItem(it.id, harness);
          if (!current) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
          forcedPrior = current.assignee ?? null;
          const holder = current.assignee?.trim();
          if (holder && holder !== ident.ownerId) {
            const reason = (it.reason ?? args.reason ?? '').trim();
            if (!reason) {
              return {
                ok: false as const,
                id: it.id,
                error: 'force_requires_reason',
                holder,
                hint: `force would clear ${holder}'s claim — pass a \`reason\` the holder and owner can audit (WI-4198).`,
              };
            }
            const verdict = await assessForceRelease({
              callerOwnerId: ident.ownerId,
              holderOwnerId: holder,
              workspaceId: ident.workspaceId ?? '',
              itemLastProgressAt:
                (current as { lastProgressAt?: string | Date | null }).lastProgressAt ?? null,
            });
            if (!verdict.allowed) {
              return {
                ok: false as const,
                id: it.id,
                error: 'force_unauthorized',
                holder,
                holderLiveness: verdict.holderLiveness,
                hint: forceRefusalHint(holder),
              };
            }
            forced = { holder, basis: verdict.basis as ForceReleaseBasis, reason };
          }
        }
        // WI-6678: capture the PRE-state so the caller can tell a real release from a
        // semantic NO-OP. Releasing an ALREADY-UNASSIGNED item is not an error, but it is
        // also not a release — and it used to return a result byte-identical to a real one.
        // That is unverifiable by any caller discipline: reading the post-state back shows
        // `assignee: null`, which is exactly what the pre-state was. Observed live on
        // 2026-08-01 — a fleet leader "reclaimed" two orphaned_in_flight items (a condition
        // that requires assignee IS NULL, so release CANNOT clear it), saw ok:true, verified
        // the post-state, and reported "orphans reclaimed" to the owner having changed
        // nothing. A mutation that reports success without reporting its DELTA cannot be
        // checked.
        //
        // The pre-state comes from releaseWorkItem's OWN row-read (onPriorState), never a
        // second read here. A call-site pre-read was the first cut of this fix and it was
        // wrong twice over: it paid a redundant round-trip on every release, and it was
        // RACY — between the call site's read and the library's, the assignee can change,
        // so `previousAssignee` could describe a state the release never acted on. A fix
        // for silent wrong answers must not itself be able to report one.
        const prior: { assignee: string | null; wasClaimed: boolean } = { assignee: null, wasClaimed: false };

        // EI-7588: compare-and-release — the UPDATE itself only touches an unclaimed row
        // or one already held by `ident.ownerId` (unless `force`), so a peer's live claim
        // can never be silently cleared. A null return here is either "not found" or "held
        // by someone else" — re-read to tell them apart and report an honest error.
        const workItem = await releaseWorkItem(it.id, {
          harness,
          expectedAssignee: force ? undefined : ident.ownerId,
          onPriorState: (p) => {
            prior.assignee = p.assignee;
            prior.wasClaimed = p.wasClaimed;
          },
        });
        // The force path read the row a moment earlier for the authority guard; prefer the
        // library's read (it is the one the UPDATE acted on) and fall back to that read only
        // if the row vanished before it.
        const priorAssignee = prior.wasClaimed ? prior.assignee : (forcedPrior ?? prior.assignee);
        const wasHeld = prior.wasClaimed;
        if (!workItem) {
          const current = await getWorkItem(it.id, harness);
          if (!current) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
          const holder = current.assignee?.trim();
          if (holder && holder !== ident.ownerId) {
            return {
              ok: false as const,
              id: it.id,
              error: 'not_holder',
              holder,
              workItem: current,
              hint: `Held by ${holder}, not you (${ident.ownerId}) — release refused so a live peer's claim isn't silently cleared. Coordinate with the holder (coord:send), or pass force:true (leader/reaper override only) to release it anyway.`,
            };
          }
          // WI-6031: a federated (origin='remote') issue-family row's UPDATE is intentionally
          // no-op'd by the harness_shared.engineer_issues_view_dml INSTEAD-OF trigger (EI-7833)
          // — the row is owned by its authoring peer's core (the hyperbee->PG projector writes
          // the base table directly under LWW) and this operator's local view writes must never
          // clobber it. That guard is correct; what was undiagnosable was the caller-facing
          // signal: every OTHER visible predicate here looks fully eligible (ids match, no live
          // holder), so a bare `release_failed` gave no hint that origin was the actual cause.
          if (current.family === 'issue' && current.origin === 'remote') {
            return {
              ok: false as const,
              id: it.id,
              error: 'release_blocked_remote_origin',
              workItem: current,
              hint: `'${it.id}' is a federated (origin='remote') issue — it is owned by its authoring peer's core and cannot be released/parked from this operator. It resolves locally when its author node resolves it upstream.`,
            };
          }
          return { ok: false as const, id: it.id, error: 'release_failed', workItem: current };
        }
        if (forced) {
          // Audit + notify AFTER the release landed — both are never-throw helpers.
          await recordForceReleaseAudit(ident.ownerId, it.id, {
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: workItem.harness ?? null,
          });
          await notifyForceRelease(ident, {
            itemId: it.id,
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: workItem.harness ?? null,
          });
        }
        // WI-5974: a release RESOLVES any pending work_items:request_release against
        // this item early — no need to wait out the announced deadline. `forced` means
        // this release happened via the EXISTING WI-4198 authority basis (holder-not-live
        // / queen / leads-holder-fleet), not the holder responding, so it resolves as
        // "superseded" rather than "holder-released". `workItem.payload` is the row AS
        // RETURNED by the release UPDATE — release never touches `payload`, so any
        // `release_request_*` keys are still current. Best-effort: never fail the
        // release itself over this.
        try {
          const pendingReq = readWorkItemReleaseRequest(workItem.payload);
          if (pendingReq && !pendingReq.resolved) {
            const resolution = forced ? 'superseded' : 'holder-released';
            const resolved = await resolveWorkItemReleaseRequest(it.id, { harness: workItem.harness ?? harness, resolution });
            if (resolved) {
              const { sendMessage: notifyRequester } = await import('../coordination/messages');
              await notifyRequester(ident, {
                to: [resolved.by],
                summary:
                  resolution === 'holder-released'
                    ? `✅ ${it.id}: ${ident.ownerId} released the item you requested (reason: ${resolved.reason.slice(0, 140)}) — no reclaim needed.`
                    : `✅ ${it.id}: released via a different authorized path before your request's deadline — no reclaim needed.`,
                harnessSlug: workItem.harness ?? undefined,
                extra: { auto: true, lifecycle: 'release_request_resolved', work_item: it.id, resolution },
              }).catch(() => {});
              await commentWorkItem(
                it.id,
                `✅ Release request from ${resolved.by} resolved early (${resolution}) by ${ident.ownerId}'s release — no consequence needed.`,
                ident.ownerId,
                { harness: workItem.harness ?? harness },
              ).catch(() => {});
            }
          }
        } catch {
          /* best-effort — never fail the release itself over release-request bookkeeping */
        }
        // WI-6678: the DELTA this call actually produced. `released:false` means the item
        // was already unassigned — the call succeeded and changed nothing. Gate on THIS,
        // not on `ok`, whenever you are trying to establish that a claim was cleared.
        const delta = {
          released: wasHeld,
          previousAssignee: wasHeld ? priorAssignee : null,
          ...(wasHeld
            ? {}
            : {
                noop:
                  `'${it.id}' was ALREADY unassigned — nothing was released. ok:true here means "the call succeeded", ` +
                  `not "a claim was cleared". If you are clearing a fleet:leader-brief orphaned_in_flight item, note that ` +
                  `condition REQUIRES assignee IS NULL, so release can never clear it — only a member CLAIMING and finishing ` +
                  `the item does (WI-6678).`,
              }),
        };
        // WI-38297: the STRANDING warning. The bg-job checkpoint classifier
        // (EI-18654296679612119) already fires on every PICKUP path — work_items:get,
        // work_items:claim, scheduler:get_next — i.e. it warns whoever inherits the item.
        // It did NOT fire here, on the way OUT, which is the moment the strand is actually
        // created: a holder writes "verification running in bg job <id>, will report+complete
        // once it finishes", releases, and their session dies taking that job's bookkeeping
        // with it (EI-16611). Nobody is ever told the item was finished, so it sits `open`
        // looking like unstarted work. Measured 2026-08-12: WI-5895 sat open 17 days that way
        // with its fix already committed, and it is not a one-off — 47 of the ~449 open,
        // unheld items holding a checkpoint cite a background job.
        //
        // WARN, never refuse. detectBgJobCheckpointClaim is deliberately BROAD ("a false
        // positive only prompts a verification the reader should do anyway"), so gating a
        // release on it would block legitimate ones on a low-precision signal. The releasing
        // agent is also the ONE reader who can cheaply settle it — they still have the pid and
        // the shell. Fail-soft: a checkpoint-read hiccup must never fail the release itself.
        const strandWarning = wasHeld
          ? await getWorkItemCheckpoint({
              harness: workItem.harness ?? it.harness ?? null,
              workItemId: it.id,
              workspaceId: ident.workspaceId ?? undefined,
            })
              .then((cp) => (cp && detectBgJobCheckpointClaim(cp).detected ? cp : null))
              .catch(() => null)
          : null;
        const stranding = strandWarning
          ? {
              strandedCheckpointWarning:
                `You are releasing '${it.id}' while its checkpoint cites a BACKGROUND JOB as the evidence it is waiting on. ` +
                `That job's bookkeeping lives in YOUR process/shell and does not survive your session (EI-16611) — the next ` +
                `reader gets a checkpoint promising a result that can never arrive, and the item sits open as if unstarted ` +
                `(WI-5895 sat 17 days that way with its fix already committed). You are the last reader who can settle this ` +
                `cheaply, while you still have the pid and the log. Before walking away, do ONE of: (a) verify the job now ` +
                `(check the referenced pid is alive AND the log reached the runner's OWN completion marker — a log that just ` +
                `stopped growing is ambiguous, not proof) and work_items:complete it; (b) re-checkpoint replacing the bg-job ` +
                `reference with a re-runnable command a successor can execute from scratch; or (c) work_items:set_state ` +
                `{ state:'blocked' } with the reason, so it lands somewhere that gets re-read instead of looking claimable.`,
            }
          : {};
        const claimHold = it.claimHold ?? args.claimHold;
        if (claimHold === undefined) return { ok: true as const, id: it.id, workItem, forced, ...delta, ...stranding };
        // WI-321 boomerang fix: a release-park is a DURABLE park (claim_hold_* provenance),
        // NOT a held_open_* lease — a lease dies ~2h after the parker's session ends
        // (WI-4531 reaper), so every park placed by an ephemeral agent boomeranged back
        // into scheduler:get_next. Parks never gate terminal transitions, so durability
        // costs nothing WI-4531 was defending against.
        const held = await setWorkItemClaimHold(it.id, claimHold, {
          harness,
          parkedBy: ident.ownerId,
          parkedReason: it.reason ?? args.reason,
        });
        return {
          ok: true as const,
          id: it.id,
          workItem,
          forced,
          ...delta,
          ...stranding,
          claimHold: held?.applicable ? held.hold : undefined,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
