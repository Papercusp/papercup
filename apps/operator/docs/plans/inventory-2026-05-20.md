---
title: Plan-file inventory (2026-05-20)
slug: inventory-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

# Plan-file inventory

Snapshot for P-301 of `agent-plan-tracking-2026-05-20.md`. Source of
truth for §8a consolidation moves and the §8b multi-fragment merges.

## Now

**State:** Inventory complete; 37 files in canonical `docs/plans/`,
13 files dispersed across 6 other locations. Four multi-fragment
families identified (sse-typed-events, llm-testing,
deck-panel-design-audit, host-architecture).
**Next:** P-302 consolidation can begin once Phase 1 read tools are
wired; until then, this doc is the manifest.

## How this was produced

```sh
# 1. Find plan-shaped files outside docs/plans/
find . \( -path ./node_modules -o -path '*/node_modules' \
       -o -path './.next' -o -path './.next-prod' \
       -o -path '*/.next*' \) -prune \
  -o -type f \( -iname '*plan*.md' -o -iname '*plan*.mdx' \
              -o -iname 'PLAN*.md' \) -print

# 2. List canonical directory
ls apps/operator/docs/plans/
```

Excluded by design:

- `node_modules/`, `.next/`, `.next-prod/`.
- `libs/papercusp/packages/harness/identity/_archived-planner.md`
  and `_archived-plan-reviewer.md` — agent **personas**, not plans.
- `libs/papercusp/packages/harness/prompts/_archived/planner.md`,
  `plan-reviewer.md`, and `plans/plan-gate.md` (under `prompts/`)
  — agent **prompts**, not plans.

## Canonical directory — `apps/operator/docs/plans/`

37 files. Includes `agent-plan-tracking-2026-05-20.md` (this plan's
parent) and `inventory-2026-05-20.md` (this file).

### Multi-fragment families — §8b merge candidates

These collapse to one file each during Phase 3 conversion.

**`sse-typed-events`** — 5 fragments:
- `sse-typed-events-2026-05-12.md` (base plan)
- `sse-typed-events-HANDOFF.md`
- `sse-typed-events-PR-SPLIT.md`
- `sse-typed-events-rebase-note-from-main.md`
- `sse-typed-events-rebase-note-from-main-round11.md`

**`llm-testing`** — 5 fragments:
- `llm-testing-framework-2026-05-14.md` (base plan)
- `llm-testing-DECISIONS.md`
- `llm-testing-handoff-2026-05-14.md`
- `llm-testing-phase1-status-2026-05-14.md`
- `llm-testing-status-2026-05-14.md`

**`deck-panel-design-audit`** — 5 fragments:
- `deck-panel-design-audit-2026-05-14.md` (base)
- `deck-panel-design-audit-followup-2026-05-14.md`
- `deck-panel-design-audit-round3-2026-05-14.md`
- `deck-panel-design-audit-round4-2026-05-14.md`
- `deck-panel-design-audit-round5-2026-05-14.md`

**`host-architecture`** — 3 fragments (newly observed 2026-05-20):
- `host-architecture-2026-05-20.md`
- `host-architecture-2026-05-20-v2.md`
- `host-architecture-blocker-report-2026-05-20.md`

### Stand-alone in `docs/plans/` — 19 files

`active-mode-proactive-ticks-2026-05-14.md`,
`agent-plan-tracking-2026-05-20.md` (this plan),
`auth-hardening-coord-note-2026-05-12.md`,
`bespoke-card-improvements-2026-05-13.md`,
`deferred-followups-2026-05-14.md`,
`design-audit-2026-05-14.md`,
`desktop-ipc-transport-completion-2026-05-20.md`,
`desktop-native-transport-2026-05-12.md`,
`file-locking-systems-comparison-2026-05-20.md`,
`handoff-2026-05-14-e2e-audit.md`,
`http2-sse-transport-2026-05-20.md`,
`inventory-2026-05-20.md` (this file),
`operator-behavior-tests-2026-05-14.md`,
`phase-4-endpoint-system-2026-05-12.md`,
`silence-nudge-reliability-2026-05-14.md`,
`su-agent-coordination-v3-2026-05-14.md`,
`tests-page-2026-05-14.md`,
`voice-aware-cards-2026-05-14.md`,
`voice-modality-spike-2026-05-13.md`,
`webkit-sse-connection-pool-2026-05-20.md`.

## Dispersed plans — §8a consolidation moves

### `apps/operator/docs/` (loose) — 6 files → `docs/plans/`

| File | Action |
|---|---|
| `agent-action-registry-plan.md` | Move |
| `dockview-migration-plan-2026-05-13.md` | Move (already dated) |
| `dockview-migration-plan-v4.md` | Move + rename to dated slug |
| `dockview-migration-plan-v4-brief.md` | Move + rename to dated slug |
| `ui-control-plan.md` | Move + add date suffix |

### `apps/operator/docs/archive/` — 3 files → `docs/plans/archive/`

| File | Action |
|---|---|
| `agent-action-registry-plan.v2.md` | Move to plans archive |
| `agent-action-registry-plan.v3.md` | Move to plans archive |
| `agent-action-registry-plan.v4.md` | Move to plans archive |

### Repo-root `docs/` — 2 files → `apps/operator/docs/plans/`

| File | Action |
|---|---|
| `docs/eager-fetch-refactor-plan.md` | Move + add date suffix |
| `docs/un-hardcode-plan.md` | Move + add date suffix |

### Repo root — 1 file → `apps/operator/docs/plans/`

| File | Action |
|---|---|
| `PLAN-operator-arc-2026-05-12.md` | Move + rename `operator-arc-2026-05-12.md` |

### Out-of-tree project plans — 2 files → `apps/operator/docs/plans/`

| File | Renamed to |
|---|---|
| `design-tokens/IMPLEMENTATION_PLAN.md` | `design-tokens-implementation-plan-<date>.md` |
| `libs/papercusp/libs/db/UNLOCKS-PLAN.md` | `db-unlocks-plan-<date>.md` |

(Date suffix is the file's git-creation date, applied during P-302.)

## Leave in place

### `apps/operator/content/internal-docs/design/` — 4 design plans

Already in fumadocs; they're finished design documents, not WIP
plans. Different artifact, different home.

- `delegate-async-plan.mdx`
- `design-phase-plan.mdx`
- `operator-card-lifecycle-plan.mdx`
- `scanner-role-plan.mdx`

### `libs/papercusp/packages/harness/` — agent personas/prompts

Excluded; they're prompts loaded by the harness role pipeline, not
documents.

## Totals

- **37** files in `apps/operator/docs/plans/` (canonical).
- **13** files dispersed (to be moved by P-302).
- **5** files leave-in-place (design plans + 1 expected design doc).
- **4** multi-fragment families totalling **18** files that collapse
  to **4** files via P-304.

After P-302 the canonical directory holds **37 + 13 = 50** files;
after P-304 it holds **50 − 18 + 4 = 36** files (minus archives that
move into `archive/`).
