---
title: Directives & CEO mode
description: User-authored direction inputs that route into projects via Business's CEO sub-role.
---

A **directive** is the top-of-stack input to the org. It's how an operator (the human, you) tells the company "work on this." The directive enters the system as a `Directive` message kind from `user` to `business`, where the **CEO** sub-role inside Business decides how many projects to spawn and routes work to other departments.

Directives sit *above* the charter — the charter says how departments interact; directives say what they should work on.

## Lifecycle

1. **Author** via the Papercup UI (`/papercup/directives` → "+ New directive") or the API (`POST /api/org/directives`). Title, body (markdown), optional priority/budget/deadline.
2. **Auto-emit** as a `Directive` message into Business's inbox.
3. **Route** by clicking "Route directive" (or letting Business's auto-loop do it). Business's CEO mode handles `Directive` kind specifically:
   - Decides how many projects this needs (1:N)
   - Calls `POST /api/org/directives/:id/projects` for each
   - Each call creates a project, fires `ProjectKickoff`, `Priority`, optional `BudgetAllocation` — all carrying the directive's id
4. **Track** progress via the directive's summary log + linked projects + linked messages. CEO appends a summary entry on every spinup.
5. **Status** transitions through `active → paused → complete | cancelled`.

A directive's full record lives at `~/.restart-org/directives.json`; its summary log at `~/.restart-org/directive-summaries.jsonl`.

## CEO sub-role

CEO is **not a department**. It's a prompt variant of Business's worker, activated only when processing a `Directive` message kind.

The base charter rules still apply: CEO has no veto authority, sends only kinds in Business's `outboxKinds`, and persists every routed message with `directiveId` for traceability.

The prompt resolution chain for CEO mode:
1. `prompts/base/worker.md`
2. `prompts/department/worker.md`
3. `prompts/department/departments/business/ceo.md` (replaces the dept worker layer)

## 1:N: a directive can spawn many projects

Earlier versions auto-created a single project per directive. The current contract allows arbitrary additional projects via repeated calls to `POST /api/org/directives/:id/projects`:

- First call: empty body → creates initial project from directive title
- Subsequent calls: `{projectName, projectVertical, projectBudgetCents, additionalContext, departments[]}` to scope each new project
- The directive's `linkedProjectIds[]` accumulates

Real example: directive "Launch music platform $20k" → CEO splits into `music-backend` (platform, $9k), `music-ios-app` (apps, $7k), `music-creator-dashboard` (apps, $4k). Each is independently tracked, has its own kickoff broadcast, and appears in Business's outbox + Management's inbox separately.

## API

```
GET    /api/org/directives?status=
POST   /api/org/directives
GET    /api/org/directives/:id
PATCH  /api/org/directives/:id
DELETE /api/org/directives/:id              # soft-cancel
GET    /api/org/directives/:id/summaries
POST   /api/org/directives/:id/summaries    # user or CEO can append
GET    /api/org/directives/:id/timeline
POST   /api/org/directives/:id/projects     # spin up another project (1:N)
POST   /api/org/directives/:id/route        # back-compat: creates first project
```

## UI

- `/papercup/directives` — index, expand-to-inline-detail, route, spin-up-project, status transitions
- `/directives/:id` — dedicated detail page with linked projects, summary log, linked messages
