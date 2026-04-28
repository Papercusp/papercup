---
title: Decision log
description: Architecture decisions and the rationale, in chronological order.
---

| When | Decision | Rationale |
|---|---|---|
| Initial | **bash + claude as the runtime** | No agent-runtime opinion. Drop-in replaceable. ~1500 lines of supervisor that anyone can read in an afternoon. |
| Initial | **Disk-only state** | Any role can be invoked from a fresh shell at any time and produce the same output. Snapshots take iteration boundaries with no quiescence. |
| Initial | **Fresh context per role** | No drift across iterations. Anthropic prompt cache absorbs the cost (99.94% hit rate observed). See [Why fresh contexts](/docs/decisions/fresh-contexts). |
| Initial | **Per-role markdown prompts** | Improvements compound without code changes. Branch-mergeable. Cache-key-stable. |
| Initial | **Curator role** | Without compaction `raw.md` grows unboundedly. Curator owns memory pruning. See [Why a curator](/docs/decisions/curator). |
| Mid | **Plan-reviewer gate** | Borrowed the structural intuition from gstack's `/plan-ceo-review` but made it autonomous and gating. Catches scope drift before any worker fires. |
| Mid | **Debugger role** | Stuck features at attempts ≥ 3 deserve root-cause analysis, not blind retry. Fires once, writes notes, next worker reads them. |
| Mid | **Crosscheck role** | Different model re-validates the validator's pass. Catches "confidently wrong" validator decisions. Optional, gated by config. |
| Late | **Cost-cap removed** | Was exiting at $25 vs real $135 spend (miscount). User wanted unbounded cost. Replaced with cost-soft-warn that paused via SIGSTOP. Even that was disabled. |
| Late | **TDD iron law in validator** | Superpowers-inspired. Behavioural assertions need a test that failed before the change. ~20-line prompt change, biggest quality lever we have. |
| Late | **Boil the lake principle** | gstack-inspired. Roles that sprawled (debugger, ui-qa, curator, product, architect) got an explicit "do fewer things perfectly" section. |
| Late | **Evidence rule** | claudecode-orchestrator-inspired. Every PASS claim must quote source output. Reports without evidence revert to failing. |
| Late | **IDENTITY.md per role** | Agent-Swarm-inspired. Cross-mission append-only memory. Curator promotes recurring patterns. |
| Late | **TRICK: convention** | MOLTRON-inspired. Worker-tagged generalisable observations get promoted to `identity/worker.md` after recurring. |
| Late | **Named checkpoints** | Hermes-inspired. Pre-agreed milestones gate progress. Distinct from escalations. Auto-fire on `triggerOn: post-planner`. |
| Late | **Git worktrees** | Composio-inspired. Each parallel lane gets its own filesystem dir. No git race possible. |
| Late | **Service smoke-test** | claudecode-orchestrator-inspired. Real curl + service startup before declaring DONE. Reopens features on failure. |
| Late | **Two-mode parallelism** | Conductor-inspired. `lane` (different features) vs `competition` (same feature, validator picks winner). |
| Late | **Decisions timeline + ghost rate** | Genuine differentiator. No other framework exposes orchestrator parse-ghost telemetry. |

## Org-layer decisions

The coding harness predated the org layer. These decisions were made when adding the company-of-directors layer on top.

| When | Decision | Rationale |
|---|---|---|
| Org-init | **5 fixed departments, no runtime mutability** | Adding/retiring directors at runtime would break the message contract (each kind has a from-dept allowlist). 5 felt right (Business, R&D, Tech, Mgmt, Marketing) and changing it requires a code change on purpose. |
| Org-init | **CEO is a mode of Business, not a 6th department** | A 6th would expand the contract surface and require new outboxKinds. Modes already exist (orchestrator vs worker vs validator); adding "ceo" as a worker-variant for Business when handling Directives kept the dept count fixed. |
| Org-init | **File-based storage** (`~/.restart-org/*.json`/`*.jsonl`) | Mirrors the existing harness pattern. No DB migration. Any role can read full state from a fresh shell. The `audit.jsonl` is the durable record. |
| Org-init | **Typed messages over conversational** | Drift catastrophe in conversational orgs. 17 named kinds, each with explicit from/to/projectId rules, server-validated. Workers can't invent new kinds. |
| Org-init | **All actions live in a project** | Reserved projects `platform-reserved` (Tech cross-cutting) and `org-ops-reserved` (governance) catch messages without a specific project so `projectId` is always set. |
| Org-init | **ACTIONS contract instead of network access for workers** | Workers run as `claude -p` subprocesses with no API access. They emit a structured `actions` block; the backend executes ops sequentially with charter validation. Failed actions abort the iteration cleanly. |
| Mid-org | **Server-side schedulers, not browser-side** | An auto-loop only when the operator has a browser tab open is useless. Schedulers live in `globalThis.__papercupSchedulers`, survive HMR, run even with all browsers closed. |
| Mid-org | **Director memory injection** | Each director's prompt now includes a synthesized `## Recent decisions (your own memory, newest first)` block from the last 12 run records. Lets directors notice patterns like "I keep deferring this." |
| Mid-org | **ProgressUpdate side-effect → project status** | Management can advance project state with a single `send_message` action (`metadata.statusUpdate: "in_progress"`). Cleaner autonomous loop — no separate PATCH op needed. |
| Mid-org | **Reserved-project guard on delete** | `DELETE /projects/:slug` rejects `platform-reserved` / `org-ops-reserved`. Reserved projects can still be wiped via direct file edit; the guard is for accidental UI/API deletes. |
| Late-org | **Health folded into Harnesses** | `/papercup/health` was a 4th view of the same 5 dept cards already on Organization + Harnesses. Folded the live ops controls onto Harnesses (now the single ops cockpit); cockpit is preserved at `_discarded/HarnessOpsCockpit.tsx` for revival. |
| Late-org | **Documentation-first tab order** | New operators learn the model before acting. Docs leftmost; Harnesses second (daily-use); reference tabs after. |
| Late-org | **Shared lib for Papercup views** | Both `apps/web/app/papercup/` and `apps/public-site/` render identical components from `libs/papercup-shared/`. Single source of truth; `readOnly` prop disables edit affordances on the public render. |

## Public-site / extraction decisions

When `apps/public-site/` was carved into its own deployable repo (so papercupai.com could be hosted from a public-build-pipeline-friendly source tree without exposing the rest of Restart), more decisions piled up.

| When | Decision | Rationale |
|---|---|---|
| Slim-repo | **Carve a separate repo for the public site** | Restart contains marketplace adapters, prompts, internal services. Making the whole monorepo public was a no-go. The slim repo includes only `apps/public-site/`, `libs/papercup-shared/`, and the harness lib trio (~155 source files, ~3MB). |
| Slim-repo | **Submodules over duplicate source** | Three internal harness libs (`ui-primitives`, `agent-chat`, `git-graph`) are needed by both the slim public repo and Restart. Duplicating would fork-drift; private npm packages added registry overhead. Each lib became a private repo under `papercupai/`, consumed by both apps via git submodule. See [Shared component libraries](/docs/architecture/shared-libs). |
| Slim-repo | **Workers Static Assets, not Pages** | When CF Pages migrated to "Workers Builds" (deploy-command-required flow), trying to deploy a Pages project from inside it failed on token-scope mismatches. Switched to a Worker with `[assets] directory = "..."` config; same static-export output, simpler auth path, and the modern Cloudflare direction. |
| Slim-repo | **Live fetch through sanitized public mirror, not snapshot files** | Earlier the public site read from snapshot JSON in `public/data/`. Replaced with runtime fetch to `https://api.papercupai.com/api/public/papercup/_admin/*` (the read-only mirror). Live state on every page load; snapshot stays only as a build-time fallback when the API is unreachable. |
| Slim-repo | **Browser-side proxy script for fetch rewriting** | Inline `<head>` script (built by `proxy-script.ts`) patches `window.fetch` and `EventSource` to rewrite admin URLs → public mirror URLs. Lets the public site embed the **exact same** admin `HarnessDashboard` component without needing per-callsite changes. |
| Slim-repo | **Read-only writes are toast, not silent 405** | Originally write attempts on the public site returned `{"error":"admin mirror is read-only"}` 405s; some callsites silently succeeded (no `res.ok` check) showing fake green toasts. The proxy script now intercepts non-GET admin fetches client-side, dispatches a `papercup:write-blocked` event, rejects the promise. A listener (`ReadOnlyToastListener.tsx`) shows a friendly sonner toast like "Reset feature is read-only on the public site". |
| Slim-repo | **Cloudflare Tunnel for the public API** | `api.papercupai.com` is a `cloudflared-papercup.service` systemd user-service tunnel pointing at the local `:3001` admin app. The tunnel only proxies `/api/public/papercup/*`. No new infra deployed; same internal app. |

## Decisions we explicitly rejected

| Rejected | Why |
|---|---|
| **AutoGPT-style infinite loop** | Drift catastrophe. Rejected in favour of supervised iterations with explicit decision verbs. |
| **LangChain orchestration** | Heavyweight Python runtime + agent abstractions we didn't need. Bash+files won. |
| **Linear/Notion task source integration** | User explicitly said no external task source. |
| **Vector DB memory (LanceDB, etc)** | Markdown files are fine until they aren't. Identity files stay sub-100KB. |
| **Discord/Slack control surface** | Coupled the harness to a particular UI chat surface. Rejected in favour of HTTP API + Next dashboard. |
| **Tmux-based agent messaging (claude-swarm)** | Coupled state to a terminal multiplexer. Files-on-disk are simpler. |
| **Subdomain-based public site rewrite** | Considered Cloudflare-rewrite of /p/papercup → public domain. Rejected: not isolated enough. Built `apps/public-site` instead. |
