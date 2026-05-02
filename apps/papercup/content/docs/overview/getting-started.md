---
title: Getting started
description: How Papercup works + the operator tutorial.
---

## How it works

Papercup is an autonomous AI company. Two files steer it:

- **`~/.restart-org/charter.md`** — *how* departments interact (5 fixed depts, 17 typed message kinds, validation rules)
- **`~/.restart-org/mission.md`** — *what* the company is for (eternal north-star — default: "Make money")

Both load into every director prompt, every run.

### Where work comes from

Two intake paths, same routing surface:

- **R&D autonomously generates `Proposal` messages** aimed at the mission
- **Humans manually create `Directive` messages** via the UI form (with optional constraints: target market, monetization model, success metric)

**Business** routes both into projects:
- For a `Directive`: dispatches a worker in **CEO mode** which emits `spinup_project` + `scaffold_harness` + `add_directive_summary` + `mark_actioned` in one ACTIONS block
- For an accepted `Proposal`: regular Business worker emits the same set
- After routing, **Management** owns the project lifecycle

### The five fixed departments

Business, R&D, Technology, Management, Marketing. Hard-coded — adding/retiring requires a code change. Each is its own harness with its own director-config, scheduler, prompts, decision/run/cost logs. Each communicates only via 17 typed inbox/outbox messages, server-validated against per-dept `outboxKinds`.

### Two harness layers

| Layer | What it does | How many |
|---|---|---|
| **Department harness** | Coordinate via messages. Workers emit ACTIONS, don't write code. | 5 fixed |
| **Coding harness** | Actually ship features. Planner→worker→validator iterates on real code. | N (one per project) |

Linked via `project.metadata.harness_slug` → entry in `~/.restart-harness-projects.json`.

### Who can scaffold a coding harness

Per-dept `allowedActions` controls this:

| Department | Can scaffold? | When |
|---|---|---|
| Business (CEO mode) | ✅ | When routing a Directive or accepting a Proposal |
| Management | ✅ | When decomposing a project (e.g. backend + frontend split) |
| Technology | ✅ | When accepting a `ProjectSpinout` for shared platform code |
| R&D | ❌ | R&D's job is generating Proposals, not building |
| Marketing | ❌ | Marketing publishes Campaigns, doesn't ship code |

Charter-enforced: rejected at `executeAction` if a dept emits an op outside its allowedActions list.

### Each new coding harness gets

- **`SPEC.md`** — concrete Phase-1 scope (template by vertical: `web-app` / `mobile-app` / `service`)
- - **`.harness/config.json`** — model defaults + scaffolding traceability

The **`product` role** inside a coding harness autonomously expands `SPEC.md` toward `SPEC.md` by writing `proposals/<ts>.md`. (Same pattern as R&D-at-the-org-layer, just project-scoped.)

### Three phases per coding harness

`staging` (port 5173, branch=main) · `testing` (port 5174, branch=testing) · `production` (port 5175, branch=production). Branches + worktrees of one harness entry, not separate registry entries. `setup-phases.sh` provisions all three.

### Roles

**Department harness — 5 LLM roles per dept:**

| Role | Purpose |
|---|---|
| `orchestrator` | Picks next inbox message; outputs decision verb (`NEXT_WORKER`, `NEXT_WORKER_CEO_MODE`, `DONE`, `ESCALATE`) |
| `worker` | Handles the chosen message; emits ACTIONS allowed by dept |
| `worker (CEO mode)` | Business-only variant for `Directive` kind |
| `validator` | Cross-checks recently-emitted outbox messages |
| `documenter` / `summarizer` | Decision-log + memory upkeep |

**Coding harness — 12 LLM roles + 1 bash:**

| Role | Fires | Output |
|---|---|---|
| `planner` | First run, no `features.json` | `features.json`, `validation-contract.md` |
| `plan-reviewer` | After planner | `plan-review.md` (accept / notes / reject) |
| `orchestrator` | Every iteration | One-line decision (`NEXT_WORKER <fid>`, etc) |
| `worker` | `NEXT_WORKER` | Feature implementation + worker-log entry |
| `validator` | `NEXT_VALIDATOR` | `issues.md` (TDD iron law + evidence rule) |
| `crosscheck` | After validator pass | Different-model second-validation (optional) |
| `ui-qa` | When claims include `VAL-UI-*` | Real-browser test |
| `debugger` | `attempts ≥ threshold` | `debug/<fid>.md` (root cause) |
| `architect` | `NEXT_ARCHITECT` | Resolves spec ambiguity (only role allowed to mutate validation-contract.md) |
| `curator` | Terminal events / every N | Memory compaction (only role allowed to *delete*) |
| `documenter` | After validator pass + on DONE | Starlight docs site |
| `product` | Near-done / on-done | `proposals/<ts>.md` (autonomous scope expansion) |
| `supervisor` *(bash, no LLM)* | External cron / non-zero exit chain | `supervisor-notes.md` |

### Two things easy to miss

- **Charter ≠ Mission.** Charter = *how* depts interact. Mission = *what* the company is for. Both load on every prompt.
- **Two harness layers.** Department harness coordinates; coding harness writes code. Don't conflate them.

---

## Operator tutorial

Now that the model makes sense, here's the day-to-day.

### The shape of one full run

```
You          → write a Directive (or R&D autonomously proposes one)
Business CEO → routes it (decides scope + which depts engage + budgets)
Management   → spins up Project, breaks into BuildRequests
Technology   → answers BuildRequests, ships Capabilities
Coding harness inside that project → planner / worker / validator iterate
Marketing    → pings about the Project as it nears launch
```

Three of those layers are on disk and observable in the UI. Your job is to write directives, occasionally answer escalations, and watch.

### 1. Make sure the org is running

Open `/papercup` (admin). It redirects to `/papercup/harnesses`. You should see the embedded Harness Dashboard with a project picker that lists:

- Department harnesses: `org-business`, `org-rd`, `org-technology`, `org-management`, `org-marketing` (`harness_kind: "department"`)
- Coding harnesses: `sheets`, `restart`, … (`harness_kind: "coding"`)

If departments aren't there, check `~/.restart-harness-projects.json`. If the org files are missing, the system seeds itself on first request to any `/api/org/*` endpoint.

### 2. Turn on the directors you want active

For each department you want running autonomously, open `/harness/org-{dept}` → **Director agent** tab → toggle **Auto: ON**. Default interval is 60 seconds.

Director schedulers are server-side. Once toggled on they keep running with all browsers closed.

You can leave a director **OFF** and only kick it manually via the **▶ Run now** button on the same tab.

### 3. Write a directive (or let R&D propose one)

**Manual path**: Go to `/papercup/directives` → **+ New directive**. Fields:

- **Title** — short ("Build a real-time spreadsheet")
- **Body** — the spec. The CEO routes based on this; be concrete about scope, deadline, constraints.
- **Priority** — `low` / `normal` / `high`. CEO weighs this when choosing scope.
- **Budget (cents)** — total $ envelope. CEO allocates across spun-up projects.
- **Constraints** (optional) — `target_market`, `monetization_model`, `success_metric`. The more specific, the more reproducible CEO routing is.

Submitting POSTs to `/api/org/directives` and auto-emits a `Directive` kind message to Business with kind `Directive`.

**Autonomous path**: with R&D auto-loop ON and `mission.md` set (default: "Make money"), R&D will propose toward the mission on its own. Edit `~/.restart-org/mission.md` (or use the Mission panel on the Organization tab) to change what R&D aims at.

### 4. Watch routing happen

Within one Business auto-loop tick (or after you click **▶ Run now** in Business's Director Agent tab), the CEO worker (for Directives) or regular Business worker (for accepted Proposals) will:

1. Read your directive / R&D's proposal
2. Decide: which departments to engage, how to split scope, what budget per project
3. Emit a routing summary (visible at `/papercup/directives/{id}`)
4. Spin up 1+ projects via `spinup_project` + `scaffold_harness` actions
5. Emit `Priority` and `BudgetAllocation` messages to Management

Each spun-up project broadcasts a `ProjectKickoff` to all 5 departments AND materializes an actual coding harness directory at `~/<slug>/`.

### 5. Watch Management decompose + Technology build

Once Management has the project, its director iterates: emit `BuildRequest`s to Technology for any reusable capabilities, send `ProgressUpdate`s back to Business as state changes.

Technology answers `BuildRequest`s with `BuildRequestResponse` (accept/reject) and ships `Capability` messages when the work lands. Capabilities auto-fan-out to every active project's metadata.

If the project has its own coding harness (e.g. `sheets`), the actual code-shipping happens there. Switch the harness picker on `/papercup/harnesses` to that project to watch planner / worker / validator iterate.

### 6. When you intervene

Most of the time you don't. Cases where you do:

- **Director loop stuck on the same decision** — open Memory tab on that dept; you'll see e.g. 5 consecutive `NEXT_WORKER_CEO_MODE` on the same message. Either edit the message status manually or pause the loop and update the director's notes.
- **Charter or mission needs adjusting** — edit `~/.restart-org/charter.md` or `mission.md` directly (or use the Mission panel UI / `PUT /api/org/{charter,mission}`). Directors re-read on next prompt.
- **Project budget exhausted or stalled** — `PATCH /api/org/projects/{slug}` to update budget_cents or status.
- **Need to retroactively model existing work** — see [Operator conventions: retroactive seeding](/operating/conventions/#retroactive-seeding-pattern).
- **Emergency stop everything** — `POST /api/org/admin/stop-all` cancels all in-flight runs and persists `autoLoop: false` to every dept.

### 7. Where to look for state

| Want to see… | Look at |
|---|---|
| What every director just did | Each dept's `Director runs` disclosure in `/harness/org-{dept}` Director Agent tab |
| Cross-org pulse (active runs, backlog, audit) | `/papercup/harnesses` (the merged ops cockpit) |
| Why this directive ended up as 1 vs N projects | `/papercup/directives/{id}` → Summaries section (CEO routing notes) |
| Whether a project is hooked to a coding harness | `/papercup/projects/{slug}` Overview → `metadata.harness_slug` |
| Audit trail (config edits, admin stops, mission edits, scaffold events) | `~/.restart-org/audit.jsonl` |

## Common patterns

See [Operator conventions](/docs/operating/conventions) for:

- `_discarded/` folder pattern when retiring components
- Backup before wiping `~/.restart-org/`
- Reserved-project quirks
- Retroactive seeding order
- BudgetAllocation accumulator gotcha
- Mission-driven autonomous Proposal flow
