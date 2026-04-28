---
title: The Org Charter
description: The five fixed departments, the message contract, and the rules that govern department interaction.
---

The Charter is governance for the Papercup org. It defines **how departments talk to each other**, not what they work on.

The canonical charter lives at `~/.restart-org/charter.md`. Each department harness reads it via symlink at `~/org-{slug}/.harness/charter.md`, so any edit is live for the next director run. The Department Harness Dashboard exposes the file in its **Charter** tab (read-only); to edit, write directly or `PUT /api/org/charter` (validated: ≥100 chars, audited).

## Immutable principles

These cannot be changed without a code change:

1. **Five fixed departments.** Business, R&D, Technology, Management, Marketing. Adding or retiring requires editing `~/.restart-org/departments.json`.
2. **No veto authority.** No director can override another. Coordination happens through messages.
3. **All actions live in the context of a project.** Every Message carries a `projectId`. Reserved projects `platform` and `org-ops` exist for cross-cutting work that doesn't belong to a specific initiative.
4. **Cyclic by design.** Marketing's `MarketSignal` feeds back into Business and R&D. There is no terminal stage.
5. **Every cross-department interaction is a typed message.** No ad-hoc channels, no shared mutable state outside the message log.

## The five departments

| Slug | Mandate | Inbox kinds | Outbox kinds |
|---|---|---|---|
| `business` | Decide which proposals to pursue. Allocate budget. Own P&L. | Directive, Proposal, MarketSignal, ProgressUpdate, PlatformUpdate | Decision, Priority, BudgetAllocation |
| `rd` | Generate and refine ideas into proposals. | MarketSignal, Decision, FeasibilityResponse, PlatformUpdate | Proposal, FeasibilityQuery |
| `technology` | Build shared platform + libs. Answer feasibility. Promote spinouts. | BuildRequest, FeasibilityQuery, ProjectSpinout | Capability, CapabilityDeprecation, FeasibilityResponse, PlatformUpdate, BuildRequestResponse |
| `management` | Execute approved projects. Coordinate Tech. Declare launch-ready. | Decision, Priority, Capability, MarketSignal, BuildRequestResponse | BuildRequest, ProgressUpdate, LaunchReady, ProjectSpinout, ProjectKickoff |
| `marketing` | Acquire customers within budget. Surface market signals. | LaunchReady, Capability, Priority, BudgetAllocation | MarketSignal, Campaign |

## Message types

Every cross-department interaction is one of these typed kinds:

| Kind | From → To | Purpose |
|---|---|---|
| `Directive` | user → business | Top-level user direction; CEO mode routes from here |
| `Proposal` | rd → business | Idea submission |
| `Decision` | business → rd, management | Approve / reject / defer with rationale |
| `Priority` | business → management, marketing | Active initiatives, ranked |
| `BudgetAllocation` | business → any | Spend authority |
| `ProgressUpdate` | management → business | Project status; can carry `metadata.statusUpdate` to advance project state |
| `BuildRequest` | management → technology | Project needs a platform capability |
| `BuildRequestResponse` | technology → management | Accept / reject with rationale |
| `Capability` | technology → all | New platform capability ready |
| `CapabilityDeprecation` | technology → all | Mark a capability deprecated; refId points at the original Capability |
| `PlatformUpdate` | technology → all | Breaking changes, deprecations, shared lib news |
| `FeasibilityQuery` | rd → technology | "Is this buildable? Constraints?" |
| `FeasibilityResponse` | technology → rd | Answer with constraints |
| `LaunchReady` | management → marketing | Project ready for acquisition push |
| `MarketSignal` | marketing → rd, business, management | Customer voice |
| `Campaign` | marketing → broadcast | Active acquisition record |
| `ProjectKickoff` | management → all | New project started |
| `ProjectSpinout` | management → technology | Propose in-project work for platform promotion |

## Charter validation

Every `POST /api/org/messages` is server-validated:

- `from` must be one of the 5 dept slugs (or `'user'` for the special `Directive` case)
- `kind` must be in the sender's `outboxKinds`
- Each `to` slug must be valid
- `projectId` must reference an existing project (defaulted to reserved `platform` or `org-ops` if absent, depending on kind)

Charter violations return HTTP 400. The autonomous loop's `executeAction` runs the same validation, so a worker that emits an illegal message fails the loop iteration rather than corrupting state.

## Editing the charter

The Department Harness Dashboard's Charter tab is read-only as of round 35. To edit:

- Edit `~/.restart-org/charter.md` directly, or
- `PUT /api/org/charter` with the new markdown body (rejects content under 100 chars).

Either path appends to the audit log (`~/.restart-org/audit.jsonl`). Department directors read the charter live via the symlink — no restart needed.
