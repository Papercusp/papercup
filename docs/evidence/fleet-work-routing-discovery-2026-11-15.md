# Discovery evidence: fleet work routing (P-008)

- **Plan:** `fleet-work-routing-visibility-2026-11-14`, item P-008, decision D-001.
- **Measured by:** su-6698d4a4, 2026-11-15 03:10–03:50 UTC.
- **Window:** `invoked_at` from 2026-11-07 00:00Z to 2026-11-14 12:00Z, workspace `papercusp-workspace`, tool `scheduler:get_next`.
- **How:** read-only SQL through host psql (`sudo -n -u postgres psql -d papercusp`), plus code reads of the staging tree. The SQL is listed with each result.

## Q1: was stop-the-line on while pulls came back gated?

The condition items that are not closed, or closed after 2026-10-25:

```sql
SELECT feature_id, harness_slug, condition_key, status,
       to_timestamp(created_ts/1000.0) AS created, to_timestamp(closed_ts/1000.0) AS closed
  FROM harness_shared.work_items
 WHERE workspace_id='papercusp-workspace' AND condition_key LIKE 'gate-red-streak:%'
   AND (closed_ts IS NULL OR closed_ts > extract(epoch from timestamptz '2026-10-25')*1000);
```

| item | harness | status | created | closed |
| --- | --- | --- | --- | --- |
| WI-10006055 | papercusp | blocked | 2026-10-05 15:34Z | never |
| WI-2146323 | sidestage | open | 2026-09-05 16:23Z | never |
| WI-39408 | hello-world-3-pot | open | 2026-08-16 06:16Z | never |

WI-10006055 has no reopen events. Its status last changed on 2026-11-08 21:35Z, to `blocked`, which is not a terminal state.

The floor's predicate (`gateRedStreakOpenForSql` in `packages/operator-core/lib/work-items-admission.ts`) matches a condition item in any non-terminal state that was created at least `STOP_THE_LINE_RED_HOURS` (24) hours ago. So stop-the-line has been on for the papercusp harness from 2026-10-06 15:34Z until now, including the whole window.

Every `get_next` row in the window targeted the papercusp harness. 293 rows returned `no-claim / all_matches_gated` (the earlier 260 figure counted only members of the 13 non-drain fleets). The first was at 2026-11-07 16:16Z and the last at 2026-11-14 11:10Z, all inside the stop-the-line period. They came from 30 distinct claim specs; `workflow-efficiency-portfolio-owner-lane` produced 121 of them, from 5 owners.

**What this does and does not show.** The timing is consistent with stop-the-line emptying these pulls. The ledger still does not say which floor emptied each pull (P-001), so this is not proof for any single row. A spec can also match bug items, which stop-the-line exempts.

## Q2: which paths does the stop-the-line floor cover?

`stopTheLineExclusionSql` is composed only into self-select reads:

- `claimNextIssueWorkItem` (`packages/operator-core/lib/work-items.ts`, the issue-family claim behind `get_next`), with the comment "a named by-id claim still bypasses, which is the owner-directed escape".
- `get_next`'s issue candidate preview column `ok_stop_line` (`packages/operator-core/lib/scheduler/get-next.ts`).
- The feature-family claim floors (`featureClaimFloorPredicatesSql` in `work-items.ts`) and their diagnostic (`diagnoseFleetScopeFeatureFamilyExclusions` in `scheduler/fleet-scope-admission.ts`).
- The claimability oracle column `ok_stop_line` (`issueClaimBarFloorColumnsSql` in `work-items.ts`).

`work_items:claim` and `coord:dispatch` (which calls `plan_items:assign`) do not compose it. `stopTheLineExplanation` tells the agent so directly: "a leader/owner can still dispatch any item BY ID".

On the feature-family path the floor is `NOT <red streak open>`, with no bug or condition exemption. The comment on it says: "while the line is stopped, feature placement self-select on the harness pauses entirely." Self-select of feature-family work on papercusp has therefore been paused since 2026-10-06.

## Q3: who records `assignedBy` before admission?

`leaderDispatchedAdmission` (`scheduler/fleet-scope-admission.ts`) admits an out-of-spec item only when the item's stored `assignedBy` equals the fleet's current leader. `assignedBy` is an issue-family column; feature-family rows have none (`work-items.ts`: "feature-family has no assigned_by column").

| path | passes an assigner to admission | stores `assignedBy` |
| --- | --- | --- |
| `work_items:create { assign_to }` | yes: `admitSubjectForFleetTarget { assignedBy: ident.ownerId }` (`work_items/create.ts`) | yes, issue family only (`createIssue { assignedBy }`) |
| `work_items:claim` for another agent | no: `admitWorkItemForFleetTarget { target, actor }`; `actor` is used only for legacy downgrade recovery | no; admission reads whatever the item already stores |
| `plan_items:assign` | no: `admitSubjectForFleetTarget { target, workspaceId, subject }` (`plan-items/assign.ts`), feature subject | no; feature family has no column |
| `coord:dispatch` | inherits `plan_items:assign` (`coordination/tools/dispatch.ts` calls `plan_items:assign`, `plan_items:status`, `coord:presence`, `coord:send` only) | no |

So the leader exception fires only for issue-family items a leader created already assigned. A leader who claims or dispatches an existing item for a member gets no recorded delegation and no leader exception.

## Q4: why do some `get_next` rows carry no outcome?

```sql
-- temp table gn = the window's get_next rows
SELECT count(*) total,
       count(*) FILTER (WHERE metadata_json ? 'schedulerDisposition') with_disp,
       count(*) FILTER (WHERE metadata_json ? 'schedulerTimeout') with_timeout,
       count(*) FILTER (WHERE NOT (metadata_json ? 'schedulerDisposition')
                          AND NOT (metadata_json ? 'schedulerTimeout')) bare
  FROM gn;
```

Result: 1,412 rows; 1,018 with a disposition, 95 with a timeout, 299 bare.

By serving build, the bare rows are:

| host | build | bare | with disposition |
| --- | --- | --- | --- |
| port-3070 | d740fc3802 | 295 | 522 |
| port-3170 | a524052311 | 2 | 368 |
| others | — | 2 | — |

The bare rows carry only dispatch-level metadata keys (`dispatchStages`, `kernel`, `requestOrigin`, `uiClientId`), with no `format` or `resultOutcome`. No owner has another `get_next` row within 2 seconds of a bare row, so they are not second rows for one call.

Build `d740fc3802` (the :3070 release build) has one `schedulerDispositionMetadata` call site, at the final return. The current source (`agent-tools/scheduler/get_next.ts`) adds `recordNoClaim` at the top of the handler, for "definite refusals [that] can return before the final disposition writer". So most bare rows are early refusals served by the older :3070 build, and the current source already records them. The 2 bare rows from :3170 build `a524052311` show at least one path may still be uncovered.

The disposition's outcome field is `kind` (`claimed` / `no-claim`). The claim-cap `reason` is free text that embeds the held item ids, which splits one reason into dozens of distinct values.

## Q5: does matching observation rows cost measurable time?

Not measured in this pass. P-003 records a 2026-11-14 01:23Z snapshot in which 239,527 of the 243,434 change items the default spec matched were observation-lane rows, and one statement timeout on the unfiltered breakdown. Under heavy host load (load average around 184 on 128 cores) the `tool_invocations` reads in this pass also hit the 5–30 s statement timeouts, so a timing taken now would not be a clean baseline. The EXPLAIN and the before/after counts are P-003's own first step and done condition.

## Q6: 131 versus 152 leader dispatches

Both figures come from one measurement (report `rpt_55c097c6-45e7-4469-9cd9-ccad38a3dec6`, session turn `session_turn:claude:54dec524-410d-4b22-b4b2-68e32b4fcf1e:10`), successful calls over the 7 days to 2026-11-14:

- **152:** every `coord:dispatch` call made by the 13 leaders who dispatched at all, to any target; it covered 105 distinct work items.
- **131:** the subset addressed to members of the leader's own fleet, in the 13 fleets other than the bug drain. The bug drain had 0.

The other 21 dispatches went to agents that were not members of the dispatching leader's fleet.
