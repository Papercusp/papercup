---
title: Messages & the ACTIONS contract
description: How departments communicate. Every action in the org is a typed, charter-validated message.
---

The **message log** is the org's append-only event source. Every cross-department action is a Message.

:::note[Migration in progress (2026-04-26)]

Per the harness-of-harnesses migration, the canonical store is moving from JSONL to SQLite. As of Layer 1.5 we **dual-write**:

- **JSONL** (legacy, still authoritative for read paths): `~/.restart-org/messages.jsonl`
- **SQLite** (new, future canonical): `~/.restart-org/.harness/store.db` via `@restart/db-org`

Both stay in sync on every `POST /api/org/messages` and every `executeAction` op. Per-dept JSONL projections at `~/org-<slug>/.harness/{inbox,outbox}-view.jsonl` still get written for backward compat with department prompts that read them.

**New SQL-source endpoints** are available now:

- `GET /api/org/inbox?dept=<slug>&since=<ts>` — indexed inbox query
- `GET /api/org/outbox?dept=<slug>` — indexed outbox query
- `GET /api/org/supervisor-notes?dept=<slug>` — markdown projection

After Layer 3 (gated on dual-run observation), JSONL will be retired and SQL becomes canonical. See `/tmp/PLAN.md`.

:::

## Message shape

```ts
type Message = {
  id: string;                  // UUID
  ts: number;                  // ms epoch
  from: string;                // dept slug or 'user'
  to: string[];                // dept slug list (single, multi, or all-broadcast)
  kind: string;                // see [charter](/docs/org/charter) for the 17 kinds
  subject: string;
  body: string;                // markdown
  refId?: string;              // points at another message id (response chain)
  projectId: string;           // required. Defaults to platform or org-ops if not set
  directiveId?: string;        // when work is tied to a directive
  status: 'pending' | 'acknowledged' | 'actioned' | 'archived';
  metadata?: Record<string, unknown>;
};
```

## Status lifecycle

- `pending` — created, unseen
- `acknowledged` — director's orchestrator has seen it
- `actioned` — director has emitted a response (or completed handling)
- `archived` — explicit admin or 30-day age sweep via `POST /admin/archive-acknowledged`

Workers in the autonomous loop transition status via the `mark_message_status` action op.

## Materialized views

When a message is appended, the central `messages.jsonl` is rebuilt and per-department views are written:

- `~/org-{dept}/.harness/inbox-view.jsonl` — messages where `to` includes the dept
- `~/org-{dept}/.harness/outbox-view.jsonl` — messages where `from` is the dept

Department directors read these local files; they don't query the central log directly. This makes director prompts cheap and self-contained.

## The ACTIONS contract

Workers in autonomous loops don't have network access — they emit a structured JSON block that the backend executes:

```json
[
  {
    "op": "send_message",
    "from": "management",
    "to": ["technology"],
    "kind": "BuildRequest",
    "subject": "...",
    "body": "...",
    "projectId": "...",
    "directiveId": "..."
  },
  { "op": "mark_message_status", "messageId": "<inbox-msg>", "status": "actioned" }
]
```

Supported ops:

| Op | Purpose |
|---|---|
| `send_message` | POST a new message (charter-validated; rejects illegal kinds) |
| `mark_message_status` | Transition status of an existing message |
| `spinup_project` | CEO mode only: create a project + auto-fire kickoff/priority/budget |
| `scaffold_harness` | Materialize a coding harness on disk for an existing project — creates `~/<slug>/` with SPEC.md, GOAL.md, .harness/config.json from a template (`web-app`, `mobile-app`, `service`) + registers in `~/.restart-harness-projects.json`. Pair with `spinup_project` so spun-up projects become real coding harnesses. |
| `pause_project` | Set project status to `paused`. Use when cost cap hit or scope ambiguity surfaced. Body: `projectSlug`, optional `reason`. Audited as `project.pause`. |
| `resume_project` | Reverse of pause — sets status to `in_progress` (or `action.status` if specified). Audited as `project.resume`. |
| `mark_campaign_published` | Marketing op: transition a `Campaign` message's metadata from draft → published. Body: `messageId`, `channels[]`, optional initial `impressions`/`clicks`/`installs`. Audited as `campaign.publish`. |
| `add_directive_summary` | Append a CEO or user summary to a directive |

Workers learn this contract from `prompts/department/worker.md`. CEO mode workers learn the spinup-aware variant from `prompts/department/departments/business/ceo.md`.

## Universal search

Every message is indexed by:

- `GET /api/org/messages?q=` — full-text on subject/body/kind/from/to within messages
- `GET /api/org/search?q=` — universal across messages, directives, projects

The dedicated `/papercup/search` page was removed in round 36 (orphan with no nav entry); the search endpoint stays as a clean API for ad-hoc queries.

## Comments (separate from refId chains)

Messages support inline comments via `~/.restart-org/message-comments.jsonl`. Comments are operator notes on a message, distinct from the response chain (which uses `refId`). Endpoints: `GET/POST /api/org/messages/:id/comments`. UI: bottom of `/messages/:id`.

## API

```
GET   /api/org/messages?from=&to=&projectId=&kind=&status=&q=
POST  /api/org/messages                          # charter-validated send
GET   /api/org/messages/:id                      # with referenced + responses
PATCH /api/org/messages/:id/status
POST  /api/org/messages/bulk-status              # update many in one request
GET   /api/org/messages/:id/comments
POST  /api/org/messages/:id/comments
```

## UI

- `/papercup/timeline` — chronological feed across all departments, kind-color-coded, filterable
- `/messages/:id` — dedicated detail with response/reference threading + comments section
