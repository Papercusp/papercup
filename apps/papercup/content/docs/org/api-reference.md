---
title: API reference
description: Every /api/org/* endpoint, grouped by purpose.
---

The Papercup org backend is a Hono module mounted at `/api/org`. 55 endpoints, all file-backed (no DB).

## Charter

| Endpoint | Purpose |
|---|---|
| `GET /charter` | Read the current charter markdown |
| `PUT /charter` | Replace the charter (≥100 chars; emits audit entry) |

## Mission

| Endpoint | Purpose |
|---|---|
| `GET /mission` | Read the current mission (`~/.restart-org/mission.md`) — the org's eternal north-star, injected into every dept's prompt |
| `PUT /mission` | Replace the mission (≥10 chars; emits audit entry as `mission.edit`) |

## Departments

| Endpoint | Purpose |
|---|---|
| `GET /departments` | All 5 with live counts, autoLoop status, scheduler info, active run |
| `GET /:dept` | Single dept with recent inbox/outbox previews |
| `GET /:dept/inbox` / `outbox` | Materialized view contents |
| `GET /:dept/notes` / `PUT /:dept/notes` | Director notes (markdown) |
| `GET /:dept/decisions` | Decision log markdown |
| `GET /:dept/director-config` / `PUT /:dept/director-config` | Auto-loop config (persisted) |

## Messages

| Endpoint | Purpose |
|---|---|
| `GET /messages?from=&to=&projectId=&kind=&status=&q=` | Filtered list |
| `POST /messages` | Send (charter-validated; auto-defaults `projectId`) |
| `GET /messages/:id` | Detail with `referenced` and `responses` |
| `PATCH /messages/:id/status` | Single status transition |
| `POST /messages/bulk-status` | Update many at once |
| `GET /messages/:id/comments` / `POST` | Operator notes on a message |

## Projects

| Endpoint | Purpose |
|---|---|
| `GET /projects?vertical=` | Filtered list |
| `POST /projects` | Create (auto-emits ProjectKickoff broadcast) |
| `GET /projects/:slug` | Detail with recent activity |
| `PATCH /projects/:slug` | Update fields |
| `DELETE /projects/:slug` | Hard delete (rejects reserved; relinks messages → org-ops) |
| `POST /projects/:slug/record-revenue` | Increment `earned_cents` (manual entry until automated revenue webhooks land) |
| `POST /campaigns/:messageId/metrics` | Update Campaign message's metrics post-publication. Body: `{ impressions?, clicks?, installs?, revenue_cents? }`. Auto-accumulates `revenue_cents` onto the project's `earned_cents`. |
| `GET /projects/:slug/timeline` | Messages where projectId matches |
| `GET /projects/:slug/capabilities` | Filtered to kind=Capability |
| `GET /projects/:slug/spinouts` | Filtered to kind=ProjectSpinout |
| `GET /projects/:slug/campaigns` | Filtered to kind=Campaign |

## Directives

| Endpoint | Purpose |
|---|---|
| `GET /directives?status=` | Filtered list |
| `POST /directives` | Create + auto-emit Directive message to Business |
| `GET /directives/:id` | Detail with summaries + linked messages |
| `PATCH /directives/:id` | Update fields |
| `DELETE /directives/:id` | Soft-cancel (status='cancelled') |
| `GET /directives/:id/summaries` / `POST` | CEO or user summary log |
| `GET /directives/:id/timeline` | Messages where directiveId matches |
| `POST /directives/:id/projects` | Spin up another project (1:N) |
| `POST /directives/:id/route` | Back-compat: creates first project |

## Director runtime

| Endpoint | Purpose |
|---|---|
| `GET /:dept/prompt?role=&mode=&context=1` | Resolved prompt with optional live state |
| `POST /:dept/run-director` | One-shot orchestrator decision (no execution) |
| `POST /:dept/run-loop` | Full autonomous loop (orchestrator → worker → execute) |
| `GET /:dept/run-director-stream` | SSE-streamed run output |
| `POST /:dept/stop-loop` | Cancel active run |
| `GET /:dept/director-runs` / `/:dept/director-runs/:filename` | Past run records |
| `GET /:dept/director-stats` | Per-dept KPI rollup |
| `GET /:dept/memory?limit=N` | Synthesized memory of recent director runs (also injected into every prompt; 1≤N≤50) |
| `GET /:dept/cost-log` | Per-call estimated-cost log for this dept (last 100 entries + total). Estimate based on prompt/output char counts × Sonnet token rates; ignores prompt cache. |
| `GET /active-runs` | All in-flight runs across departments |
| `GET /schedulers` | Server-side timers with `secondsRemaining` |
| `GET /all-director-stats` | Cross-org KPI aggregation |
| `GET /health-snapshot` | Composite snapshot — depts + active runs + backlog (msgs/projects/directives by status) + project warnings (cost-cap breaches) + last 20 audit entries, single fetch |

## Search

| Endpoint | Purpose |
|---|---|
| `GET /search?q=` | Universal — messages + directives + projects |

## Audit

| Endpoint | Purpose |
|---|---|
| `GET /audit?subject=&action=&limit=` | Audit log for charter/config/admin changes |

## Admin

| Endpoint | Purpose |
|---|---|
| `POST /admin/rebuild-views` | Rebuild materialized inbox/outbox files |
| `POST /admin/stop-all` | Emergency stop — cancel runs + clear schedulers + persist autoLoop=false |
| `POST /admin/archive-acknowledged?olderThanMs=` | Sweep acknowledged messages older than N ms (default 30d) |
| `POST /admin/execute-action` | Invoke an ACTIONS op directly (same machinery the autonomous loop uses). Body: `{ action: { op: ..., ... } }`. Useful for manual scaffolding or testing new ops. |

## Secrets

Single-key text files at `~/.restart-org/secrets/<key>.txt`, mode 0600. Used for credentials workers need to ship apps (EAS tokens, App Store Connect keys, Google Play service-account JSON, RevenueCat API keys, etc).

| Endpoint | Purpose |
|---|---|
| `GET /secrets` | List keys + lengths only (no plaintext) — safe for UI |
| `GET /secrets/:key` | Get plaintext value (for server-side worker use) |
| `PUT /secrets/:key` | Set value. Body: `{ value }`. Audited as `secret.set`. |
| `DELETE /secrets/:key` | Remove. Audited as `secret.delete`. |

## Side effects on `appendMessage`

Some message kinds trigger automatic state mutations (no separate API call needed):

- `Capability` (from technology) — increments `capabilitiesAvailable` on every active non-reserved project
- `CapabilityDeprecation` (from technology) — decrements counter; appends to `deprecatedCapabilities[]`
- `BudgetAllocation` (with projectId + metadata.amount_cents) — accumulates into `budget_cents`
- `ProgressUpdate` (from management, with metadata.statusUpdate) — advances project status

Charter validation always runs server-side, so a worker that emits something illegal fails the loop iteration rather than corrupting state.
