/**
 * operator-sentinel-handoff-deps — the real-substrate wiring of SentinelHandoffDeps
 * (sentinel-herald Phase 4). Kept SEPARATE from the dispatch core
 * (operator-sentinel-handoff.ts) so the core unit-tests against injected deps with
 * no PG/coord, and converse.ts gets one factory to call.
 *
 * Each dep maps onto an EXISTING substrate primitive — reuse, don't rebuild:
 *   - createWorkItem      → work-items.createWorkItem (kind=change, the user-ask
 *                            issue-family kind; unassigned so the Queen's default
 *                            create-demand subscription wakes her; urgent → hive
 *                            urgent-wake). Tags `user-requested` (the P-016 gate).
 *   - setPriority         → work-items.setWorkItemPriority (the Queen's backlog
 *                            order lever; bump to head).
 *   - subscribeOperator   → work-items.subscribeWorkItem as OPERATOR_COORD_OWNER
 *                            (the same owner the hindsight drain reads).
 *   - nudgeQueen          → coord send/escalate to @role:queen (the slot selector
 *                            parks→drains on her next spawn) with the urgent-wake
 *                            already fired by the work_item create.
 *   - surfaceForApproval  → coord:escalate (question) to the human + a standing-
 *                            approval candidate refresh, so the user can grant a
 *                            standing approval for the (capability, harness) pair.
 *   - standingApprovals   → operator-preferences.loadPreferences().standingApprovals
 */

import type { SentinelHandoffDeps } from './operator-sentinel-handoff';
import { USER_REQUESTED_LABEL, HANDOFF_CAPABILITY } from './operator-sentinel-handoff';

/** Build the real-substrate deps. Pure module-level — no PG touched until a dep
 *  is actually called (each lazy-imports its substrate module so importing this
 *  factory stays cheap on the converse hot path). */
export function defaultSentinelHandoffDeps(): SentinelHandoffDeps {
  return {
    async createWorkItem(input) {
      try {
        const { createWorkItem } = await import('./work-items');
        const wi = await createWorkItem({
          // `change` = a desired one-off the user asked for (work_items:create
          // guidance) — issue-family, so it stays workspace/harness-scoped and is
          // NOT hive-gated (a feature would require a resolved hive). Unassigned so
          // the Queen's default demand wake fires.
          kind: 'change',
          title: input.title,
          summary: input.summary,
          harness: input.harness ?? undefined,
          workspaceId: input.workspaceId,
          topics: [input.label],
          createdBy: 'papercup',
          urgent: input.urgent,
        });
        return { id: wi.id };
      } catch (err) {
        console.warn('[sentinel-handoff] work_item create failed:', (err as Error).message);
        return null;
      }
    },

    async setPriority(id, _priority, harness) {
      const { setWorkItemPriority } = await import('./work-items');
      // priority 0 = head of the backlog (lower = claimed sooner). The user-asked
      // item should be the next thing the Queen's backlog surfaces.
      await setWorkItemPriority(id, 0, { harness: harness ?? undefined });
    },

    async subscribeOperator(workItemId, harness) {
      const [{ subscribeWorkItem }, { OPERATOR_COORD_OWNER }] = await Promise.all([
        import('./work-items'),
        import('./delegated-tasks'),
      ]);
      await subscribeWorkItem(OPERATOR_COORD_OWNER, workItemId, 'full', {
        harness: harness ?? undefined,
      });
    },

    async nudgeQueen({ workItemId, summary, urgent, harness }) {
      const [{ sendMessage }, { openEscalation }, { OPERATOR_COORD_OWNER }] = await Promise.all([
        import('./agent-tools/coordination/messages'),
        import('./agent-tools/coordination/escalations'),
        import('./delegated-tasks'),
      ]);
      // The Sentinel speaks AS the operator owner on the coord substrate (same
      // identity the hindsight channel + delegated-tasks use). It runs server-side
      // with no MCP ctx, so build the operator identity directly.
      const identity = {
        ownerId: OPERATOR_COORD_OWNER,
        ownerLabel: 'papercup',
        source: 'principal' as const,
        workspaceId: null,
        userId: null,
      };
      const body = `Filed ${workItemId} (user-requested): ${summary}`;
      if (urgent) {
        // Urgent → escalation channel (the Queen's default coord:escalate demand
        // subscription wakes her), advisory severity (it's a nudge, not a blocker).
        await openEscalation(identity, {
          severity: 'advisory',
          summary: `Sentinel handoff (urgent): ${summary}`.slice(0, 280),
          body,
          ...(harness ? { meta: { harnessSlug: harness } } : {}),
        });
      } else {
        // Routine nudge → coord:send to the Queen's role-slot with an optimistic
        // wake (the work_item create already fired the demand wake; this is the
        // durable inbox record). @role:queen parks→drains on her next spawn.
        await sendMessage(identity, {
          to: ['@role:queen'],
          summary: `Sentinel handoff: ${summary}`.slice(0, 200),
          body,
          ...(harness ? { harnessSlug: harness } : {}),
        });
      }
    },

    async surfaceForApproval({ summary, tier, capability, harness }) {
      const [{ openEscalation }, { refreshCandidates }, { OPERATOR_COORD_OWNER }] =
        await Promise.all([
          import('./agent-tools/coordination/escalations'),
          import('./operator-standing-candidates'),
          import('./delegated-tasks'),
        ]);
      const identity = {
        ownerId: OPERATOR_COORD_OWNER,
        ownerLabel: 'papercup',
        source: 'principal' as const,
        workspaceId: null,
        userId: null,
      };
      // A medium/high action awaiting approval → a `question` escalation the user
      // resolves, plus a standing-candidate refresh so the settings page can offer
      // a STANDING approval for this (capability, harness) pair (the user-facing
      // approval tier — P-015). The Queen places once the user approves.
      //
      // WI-2200 (EI-3643): the Sentinel re-proposes the SAME gate (identical
      // capability + harness) across turns with a FRESHLY-worded `summary` each
      // time (its own natural-language restatement) — without an explicit dedup
      // key, openEscalation's default subjectSignature falls back to the raw
      // summary text (escalationDedupIdentity), so every reworded restatement
      // reads as a NEW subject and never dedupes against the still-open request
      // for the SAME underlying approval. Observed live: 34 open escalations for
      // capability=cup:spawn/fleet:spawn harness=workspace, all differently
      // worded, none ever resolved — pure backlog-drift noise. Pin BOTH dedup
      // fields to the stable (capability, harness) identity so a re-proposal
      // bumps the EXISTING escalation's repeatCount (openEscalation's built-in
      // findOpenDuplicate/tryBumpProjectionDuplicate path) instead of minting a
      // duplicate the user has to individually triage.
      await openEscalation(identity, {
        severity: 'question',
        summary: `Approve ${tier}-tier action? ${summary}`.slice(0, 280),
        body:
          `The Sentinel wants to hand off a ${tier}-tier action (capability=${capability}, ` +
          `harness=${harness ?? 'workspace'}). Approve to let the Queen place it; ` +
          `grant a standing approval to skip this prompt next time.`,
        meta: {
          dedupKind: 'sentinel-handoff-approval',
          subjectSignature: `${capability}:${harness ?? 'workspace'}`,
        },
      });
      await refreshCandidates().catch(() => {});
    },

    async standingApprovals() {
      const { loadPreferences } = await import('./operator-preferences');
      const prefs = await loadPreferences();
      return prefs.standingApprovals.map((a) => ({
        capability: a.capability,
        targetHarness: a.targetHarness,
      }));
    },
  };
}

// Re-exported so converse.ts and tests have one import site for the label/cap.
export { USER_REQUESTED_LABEL, HANDOFF_CAPABILITY };
