---
title: Projects
description: The execution unit. Every Message is project-scoped. Directives can have many projects.
---

A **project** is the execution unit in Papercup. It's where actual work happens — typically one project corresponds to one coding harness (`/harness/:slug`) running its own `run.sh` loop with planner/worker/validator/etc.

Every Message in the org log carries a `projectId`. There are no orphan messages.

## Project record

```ts
type Project = {
  id: string;                      // UUID
  slug: string;                    // human-readable, used as harness directory
  name: string;
  vertical: string;                // 'apps' | 'mobile-app' | 'service' | 'platform' | ... (free-form; templates know mobile-app/service/web-app)
  status: 'proposed' | 'approved' | 'in_progress' | 'launched' | 'paused' | 'cancelled';
  owning_director: string;         // 'management' by default
  budget_cents: number;            // accumulates from BudgetAllocation messages
  spent_cents: number;
  earned_cents?: number;           // accumulates from POST /projects/:slug/record-revenue
  cost_cap_cents?: number;         // operator-set hard ceiling; informational today, enforced in a future round
  created_ts: number;
  metadata?: {
    sourceDirective?: string;      // back-link to the directive that spawned it
    additionalContext?: string;    // per-project scope CEO captured at spinup
    harness_slug?: string;         // slug in ~/.restart-harness-projects.json (set by scaffold_harness)
    harness_path?: string;         // absolute path to coding harness root
    scaffolded_ts?: number;        // when scaffold_harness ran
    capabilitiesAvailable?: number;
    deprecatedCapabilities?: Array<{ ts; subject; messageId; refId? }>;
    lastCapability?: { ts; subject; messageId };
    reserved?: boolean;            // true for `platform` and `org-ops` only
  };
};
```

Persisted at `~/.restart-org/projects.json`.

## Two reserved projects

Cross-cutting work needs a project home, so two reserved slugs exist:

- **`platform`** — owned by Technology. Default home for `PlatformUpdate`, shared `Capability` releases, and any work whose value crosses all verticals.
- **`org-ops`** — owned by Business. Default home for governance: charter changes, the initial `Directive` message before it's routed, market signals not yet pinned to a specific project.

The reserved flag in metadata prevents these from being deleted via `DELETE /api/org/projects/:slug`.

## Auto-side-effects on a project

Several message kinds mutate the project record automatically when they hit `appendMessage`:

| Kind | Effect on project |
|---|---|
| `BudgetAllocation` (with `projectId` + `metadata.amount_cents`) | `budget_cents += amount_cents` |
| `Capability` (from technology) | All non-reserved active projects: `metadata.capabilitiesAvailable++`, record `lastCapability` |
| `CapabilityDeprecation` (from technology) | All non-reserved active projects: decrement `capabilitiesAvailable`, append to `deprecatedCapabilities[]` |
| `ProgressUpdate` (from management, with `metadata.statusUpdate`) | `status = metadata.statusUpdate` |

The `ProgressUpdate` side-effect is what lets Management's worker advance project state via a single `send_message` action — no separate PATCH op needed.

## API

```
GET    /api/org/projects?vertical=
POST   /api/org/projects                    # auto-emits ProjectKickoff
GET    /api/org/projects/:slug
PATCH  /api/org/projects/:slug
DELETE /api/org/projects/:slug              # rejects reserved; relinks messages → org-ops
GET    /api/org/projects/:slug/timeline     # all messages where projectId matches
GET    /api/org/projects/:slug/capabilities # filtered to kind=Capability
GET    /api/org/projects/:slug/spinouts     # filtered to kind=ProjectSpinout
GET    /api/org/projects/:slug/campaigns    # filtered to kind=Campaign
```

## UI

- `/papercup/projects` — portfolio grouped by vertical; "+ New project" creates + auto-broadcasts ProjectKickoff
- `/projects/:slug` — 7-section detail view: Overview / Timeline / Build (links to harness) / Capabilities / Spinouts / Campaigns / Settings (with Danger zone for delete)
- The Build section's "Open in harness →" jumps to `/harness/:slug` which routes to the coding-harness UI for that project

## Project ↔ Directive linkage

A project knows the directive that spawned it via `metadata.sourceDirective`. The Project Overview surfaces it as a clickable callout. Each linked project on a directive's detail page click-throughs to the project. Both directions are deep-linkable.

A directive can spawn many projects. A project belongs to at most one directive (the one in `sourceDirective`); manually-created projects (via `POST /api/org/projects`) have no source directive.
