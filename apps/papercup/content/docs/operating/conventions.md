---
title: Operator conventions
description: Patterns the team has settled on for managing Papercup state — discarded components, backups, retroactive seeding, message side-effects to watch.
---

These are conventions adopted across the build, not enforced by code. Following them keeps state recoverable and avoids surprises.

## `_discarded/` folders for retired UI

When a component is removed from active use but the team isn't sure they want to throw it away, it moves to `_discarded/` rather than being deleted. The folder is **not exported** from `index.ts` and nothing imports from it.

Current location: `libs/papercup-shared/src/_discarded/`. Each entry has a sibling `README.md` with:

- Why removed
- What round
- How to revive (usually one line — re-export from `index.ts`)

This keeps git blame clean (no later "I wonder why we deleted that") and makes A/B reconsideration cheap.

## Backup before wiping `~/.restart-org/`

The org store (`projects.json`, `directives.json`, `messages.jsonl`, `directive-summaries.jsonl`, `message-comments.jsonl`, `audit.jsonl`) is plain files; one bad `>` redirects everything to nothing. Before any wipe, `cp` the originals to `~/.restart-org/_backup-test-data/` with a timestamp suffix:

```sh
ts=$(date +%Y-%m-%dT%H-%M-%S)
mkdir -p ~/.restart-org/_backup-test-data
for f in projects.json directives.json messages.jsonl directive-summaries.jsonl message-comments.jsonl; do
  [ -f ~/.restart-org/$f ] && cp ~/.restart-org/$f ~/.restart-org/_backup-test-data/${f}.${ts}
done
```

Restoring is a `cp` back. The audit log is intentionally not wiped — it's append-only history and stale subject IDs are harmless.

## Reserved projects (`platform`, `org-ops`)

`org.ts` defaults messages without an explicit `projectId` to:

- `platform-reserved` for `Capability` / `PlatformUpdate`
- `org-ops-reserved` for everything else

If the reserved projects are deleted, future broadcasts will still write the constant ID — they just point at nothing. Project-detail pages for those messages will look orphaned. Either keep the reserved projects, or recreate them when the org starts running again. Their original `metadata` is preserved in any timestamped backup if you need to restore.

## Retroactive seeding pattern

Sometimes a coding harness exists before the org-level pipeline does (the `sheets` harness predated the directive/project model). To retrofit it, create the chain in order:

1. `POST /api/org/directives` — the originating user directive
2. `POST /api/org/projects` with `metadata.harness_slug` + `metadata.harness_path` + `metadata.sourceDirective` (auto-emits ProjectKickoff broadcast)
3. `PATCH /api/org/directives/<id>` to add `linkedProjectIds` + `assignedDepartments`
4. `POST /api/org/directives/<id>/summaries` — the CEO routing rationale
5. `POST /api/org/messages` for Priority + ProgressUpdate to make the timeline plausible

### BudgetAllocation accumulator quirk

`BudgetAllocation` messages have a side-effect that **adds** `metadata.amount_cents` to the project's `budget_cents`. If you create the project with a non-zero budget *and* send a BudgetAllocation for the same amount, the budget gets doubled.

Two safe paths when seeding:

- Create the project with `budget_cents: 0`, then let the BudgetAllocation accumulate the real amount, **or**
- Create with the full amount, then send BudgetAllocation with `metadata.amount_cents: 0` as informational only

If you discover doubling, `PATCH /api/org/projects/<slug>` with the corrected value to fix.

## Mission-driven autonomous Proposal flow

The default operating mode is autonomous: R&D continuously generates Proposals aimed at the org's `~/.restart-org/mission.md`. The user only writes Directives as the override path.

The chain:

1. **`mission.md`** is injected into every dept's prompt as the first context section. Default content: "Make money".
2. **R&D worker** reads the mission + inbox + outbox + portfolio. Either:
   - Reactive: an inbox `MarketSignal` from Marketing or `Capability` from Tech triggers a proposal
   - Proactive: empty inbox + nothing recently proposed → autonomous proposal toward the mission
3. **R&D emits a `Proposal`** message (kind=Proposal) to Business with structured metadata: monetization model, estimated_cost_cents, weeks_to_revenue, success_metric.
4. **Business orchestrator** picks up the Proposal (priority: Directives first, then Proposals scored by impact/cost), dispatches a worker.
5. **Business worker** decides accept / reject / defer:
   - **Accept**: emit `Decision` + `spinup_project` + `scaffold_harness` + `mark_message_status: actioned` — all in one ACTIONS block. The project materializes immediately.
   - **Reject**: emit `Decision` with concrete reasoning + suggested refinement
   - **Defer**: emit `Decision` with the condition that would unblock it, status=`acknowledged` (parked, not closed)
6. **Management** sees the kickoff broadcast + Priority message + takes over project execution as normal.

Compare to the user-Directive path: the user writes a Directive, Business orchestrator picks it up, dispatches **CEO mode** (a worker variant), CEO emits the same `spinup_project` + `scaffold_harness` actions. The end-state is identical — a real project with a coding harness.

So the org has two intake paths but one routing surface:

| Source | Worker mode | Trigger |
|---|---|---|
| User Directive | CEO mode (Business worker variant) | Inbox kind=Directive |
| R&D Proposal | Regular Business worker | Inbox kind=Proposal, Decision=accept |

To change the org's direction without writing code, edit `~/.restart-org/mission.md` (or the Mission panel on the Organization tab). R&D will start proposing toward the new direction on its next director run.
