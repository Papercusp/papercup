---
title: Retiring `harness-fs-watcher.ts`
slug: fs-watcher-retirement-2026-05-10
status: active
created: 2026-05-10
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** Status as of `2cfbbd5` + `a84288f`.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Retiring `harness-fs-watcher.ts`

Status as of `2cfbbd5` + `a84288f`.

The chokidar-based "FS-canonical, PG-mirror" watcher is the last large
fs-driven persistence path in the operator. This doc enumerates each
mirror and what's needed to retire it, replacing it with **producer
writes directly to PG**.

## Pattern in use today

```
producer  →  file on disk
              ↓ (chokidar fs event)
            replaceX(slug, path)
              ↓
            INSERT/UPDATE/DELETE PG rows
              ↓ (Zero replication)
            UI subscribers
```

## Pattern we want

```
producer  →  POST /api/internal/<x>-event   (bash producers)
   OR
producer  →  direct sql`INSERT…`            (operator producers)
              ↓
            PG row
              ↓ (Zero replication)
            UI subscribers
```

The `harness_decisions` migration in `2cfbbd5` is the canonical worked
example for the bash-producer flavour. The `harness_run_chunks` /
`harness_run_output` / `harness_expert_*` migrations in earlier arcs
are the worked examples for the operator-producer flavour.

## Mirror inventory + migration plan

### Already retired in this arc

| Mirror | When | How |
|---|---|---|
| `harness_features` | earlier arc | Operator endpoints write directly |
| `harness_mission_state` | earlier arc | Same |
| `harness_dispatches` | earlier arc | Same |
| `harness_run_output` | earlier arc | Same; chunks via run-chunk-bus |
| `harness_snapshots` | earlier arc | Same |
| `harness_checkpoints` | earlier arc | Same |
| `harness_experts` + `harness_expert_feedback` + `harness_expert_turns` | this session | Operator endpoints write directly; watcher mirror retired in `950ba1c` + `6d83032` |
| `harness_decisions` | this session | Bash POSTs to `/api/internal/decision-event`; mirror retired in `2cfbbd5` |

### Still mirroring — operator-producer flavour (direct PG write)

| Mirror | Producer | Effort | Notes |
|---|---|---|---|
| `harness_branch_actions` | `lib/branch-actions.ts` runAction + `branch-action-manifest.ts` | M | Derived cache, not just mirror — listing actions, listing runs, env resolution. Needs explicit refresh hooks at every input mutation (action created, run started, plugin enabled, plugin config changed). Or push enrichment to query time. |
| `harness_archives` | bash snapshot rotation hook | S–M | Add a hook in run.sh that POSTs metadata after creating each `.tar.gz`. The file is the artifact (binary); only the metadata row needs to move. |
| `harness_screenshots` | playwright/agent screenshot tools | M | Same shape: PNG file is the artifact, metadata row written when produced. Needs to identify every code path that writes a screenshot. |
| `harness_phases` | bash worktree creation + config.json | M | Phase rows describe staging/testing/production worktrees + iteration state. Operator endpoint that creates worktree should write the row. |
| `harness_health` | heuristic file-presence checks | M–L | Each file-presence signal becomes an explicit health write. Lots of producers to find. |
| `harness_smoke_test` | bash smoke-test runner | S | Bash POSTs structured smoke result; same shape as decision-event. |
| `harness_feature_prs` | bash PR-link emit | S | Bash POSTs the PR list when run.sh notices a change. |
| `harness_feature_debug_notes` | bash debug-note hook | S | Bash POSTs note content when run.sh writes one. |

### Still mirroring — query-cache flavour (read on demand)

| Mirror | Why kept | Replacement |
|---|---|---|
| `harness_git_log` | git is the producer; we cache its output | Drop the mirror; have `/api/harness/<slug>/git-log` shell out on demand. UI loses Zero subscription, calls REST instead. |

### Still mirroring — external-LLM-tool flavour (file is the producer's interface)

These need new MCP tools that write PG instead of files. Until those
tools exist, the mirror is the integration boundary:

| Mirror | Producer | What's needed |
|---|---|---|
| `harness_skills` | LLM curator's `Write` tool on `.harness/skills/*.md` | New MCP tool: `record_skill({slug, body})` → INSERT |
| `org_charter` / `org_departments` / `org_projects` / `org_inbox` / `org_outbox` / `org_notes` / `org_decisions` | org-curator LLM tool calls writing files in `<org-root>/` | New MCP tools per-table: `record_charter(...)`, `set_department(...)`, etc. |
| `identity-files-watcher` (`harness_identity_files`) | LLM curator writing `~/autonomous-harness/identity/*.md` | New MCP tool: `record_identity({role, body})` |

The MCP-tool migration is its own arc. Until then, those mirrors
remain the integration shim. **`fs.watch` is still wrong here**, but
the cure requires a different tool surface, not a code-side rewrite.

### Already justified (non-persistence)

| Site | Why kept |
|---|---|
| `lib/plugin-host-runtime.ts:780` (raw `fs.watch`) | Dev-time hot-reload signal. The user editing code IS the producer. Pure code-change watcher. |

## Recommended order for the next arc

1. **Drop `harness_git_log`** — replace with on-demand REST. Smallest migration, biggest line-count reduction (~100 lines deleted).
2. **`harness_smoke_test`, `harness_feature_prs`, `harness_feature_debug_notes`** — three bash-producer migrations following the `decision-event` template exactly. Each ~50 lines new + ~80 lines deleted.
3. **`harness_archives`** — bash hook + metadata POST. Same template.
4. **`harness_phases`** — operator producer; medium effort, several callers.
5. **`harness_branch_actions`** — derived cache; needs explicit refresh hooks at every input mutation. Largest effort.
6. **`harness_health`** — depends on (5).
7. **`harness_screenshots`** — operator producer; medium effort.
8. **MCP tool arc** for skills/identity/org_*.

## Final state target

`harness-fs-watcher.ts` ends up at maybe 600 lines (down from ~2700),
covering only the LLM-tool integration boundary mirrors until those
tools migrate to PG-write. Direct `fs.watch` usage in the entire
codebase reduces to one site (plugin hot-reload).

`fs.watch` becomes a non-persistence primitive. JSONL files become
either short-lived buffers (cleaned up at process exit) or external
producers' artifacts.
