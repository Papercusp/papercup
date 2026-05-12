# PR split plan — sse-typed-events branch

**51 commits** on `papercup#sse-typed-events`, **5 commits** on
`papercup-desktop#sse-typed-events-ipc`, **1 commit** on
`papercusp#sse-typed-events-transport-column` (submodule).

The branch is a coherent multi-phase project but too big for a single
PR. This doc maps every commit to its target PR + lays out the
landing order. Reviewer-friendly chunks; each PR can be reviewed and
merged independently.

## Landing order + dependency graph

```
PR 1 (wire-format) ────────┐
PR 2 (framework) ───────────┼──→ PR 3 (migrations) ──→ PR 6 (deferred)
                            │                              ↑
                            │                              │
PR 4 (IPC) [+ desktop PR    │                              │
   + submodule PR] ─────────┘                              │
                                                           │
PR 5 (audit fixes) ────────────────────────────────────────┘
```

Strict requirements:
- **PR 1 must land before PR 2**: PR 2's typed-events code depends on
  PR 1's `@restart/sse`-based `SseSink`.
- **PR 2 must land before PR 3**: PR 3's migrated tools use the
  `defineTool({events})` surface from PR 2.
- **PR 4 must land before PR 6**: PR 6's `transport` column + IPC
  allowlist additions assume PR 4's IPC server exists.
- **PR 5 can interleave**: audit fixes are scattered across all
  earlier work but each commit is local to one file.
- **Cross-repo PRs ship together**: PR 4 needs the desktop branch's
  IPC client merged in parallel; PR 6 needs the submodule branch
  merged in parallel.

---

## PR 1 — Wire-format normalization (Phase 1+2)

**Theme:** Hand-rolled SSE producers/consumers move to `@restart/sse`.
**Commits (4):**

| SHA      | Subject |
|----------|---------|
| `3012294b` | docs(plans): SSE library adoption + endpoint-system typed event channel |
| `bc836d91` | agent-mcp: handleHttpToolRequestStreaming writes into SseSink |
| `96e43390` | operator: agent-tools + plugins + test-buttons routes use sseResponse |
| `dd5af320` | operator: branch-actions + delegation consume via parseSseStream |

**Risk:** Low. Pure refactor; same wire format on the wire. Existing
tests already exercise the new paths.

---

## PR 2 — Phase 3 framework (typed events)

**Theme:** `defineTool({events})` + `ctx.emit` + three transport adapters.
**Commits (10):**

| SHA      | Subject |
|----------|---------|
| `f5294678` | plugin-sdk: add EmitCallback + ctx.emit to ToolContext |
| `5310670c` | agent-mcp: add UnifiedToolContext.emit; populate at construction sites |
| `563ce8bd` | agent-mcp: defineTool gains 'events' + 'idleTimeoutSec'; reserved-name guard |
| `c6df524d` | agent-mcp: dispatcher enforces idleTimeoutSec via emit watchdog |
| `b34decbe` | agent-mcp: HTTP transport wires emit→sink; auto-done + auto-error |
| `cc10b664` | operator: MCP transport fires notifications/papercusp/event on ctx.emit |
| `df01e7e1` | agent-mcp: tools/list surfaces events JSON-schemas (z.toJSONSchema) |
| `bcf5c114` | operator: strict-streamable gating on agent-tools + plugins routes |
| `70d0b841` | agent-mcp: add dispatchProjectedToolStream — in-process iterator |
| `125c87c7` | docs: endpoint-system typed-event streams + three-context-types |
| `9226cc64` | agent-mcp: schema-inferred SSE wire format (string vs JSON) |
| `307005f7` | agent-mcp: surface .describe() content-type hints through tools/list |

**Risk:** Medium. New framework surface; existing tools unaffected
(events is optional). Reserved-name guard is compile-time; can break
external code that names a tool's event `done`/`progress`/etc — but
no such tool exists yet.

---

## PR 3 — Phase 3 migrations (5 routes → tools)

**Theme:** architect:chat, brainstorm:chat, operator:scan,
operator:converse, operator:delegate become `defineTool` projections.
**Commits (5 + 2 supporting):**

| SHA      | Subject |
|----------|---------|
| `c5324380` | operator: Pilot 1 — extract operator.scan streaming-chat core as a tool |
| `1512ae2b` | operator: Pilot 2 — extract architect:chat streaming-chat core as a tool |
| `c56a3ba4` | operator: fold-in brainstorm:chat as a sibling of architect:chat |
| `538e8ddc` | operator: fold-in operator:converse as a projected tool |
| `988b12e1` | operator: fold-in operator:delegate as a projected tool |
| `a0ff90a7` | operator: delete dead operator-chat route |
| `486314fb` | operator(tests): per-tool migration regression for 5 streaming tools |

**Risk:** Higher per route. Each route's pre/post side-effects move
into the tool; wire format is preserved. Tests catch wire-shape
regressions but not all behavioral ones. **Test on staging
operator-converse + delegate paths before merge.**

---

## PR 4 — Desktop IPC infrastructure

**Theme:** New transport: Unix-domain-socket / named-pipe between
Tauri webview and Node sidecar.
**Commits on papercup (5):**

| SHA      | Subject |
|----------|---------|
| `32da546b` | docs(plans): desktop-native transport for the endpoint system |
| `a29a593f` | endpoint-ipc: frame codec + PROTOCOL.md + trust-boundary doc |
| `f85880af` | endpoint-ipc: Node IPC server + binary wire kind |
| `1f3601d9` | transport-adapters: HTTP + Tauri-IPC consumers + picker |
| `8da842cb` | operator(instrumentation): opt-in endpoint IPC server boot |
| `89d4fe01` | endpoint-ipc: dev:ipc_echo verification tool + /dev IPC tab |

**Companion PRs (must merge in lockstep):**
- `papercup-desktop#sse-typed-events-ipc` — Rust IPC client + Tauri
  commands + framing module + sidecar handshake. 5 commits ahead.
- (Submodule pointer bump lands with this PR.)

**Risk:** Highest. Cross-repo coordination; new sidecar lifecycle
path. Gated by `PAPERCUSP_DESKTOP_IPC=1` env so default behavior is
unchanged. Run `papercup-desktop/bin/verify-desktop-ipc.sh` before
merge.

---

## PR 5 — Audit fixes (rounds 1–7)

**Theme:** 14 bugs caught across seven audit passes after the initial
migrations landed. Each fix is small and locally scoped.
**Commits (10):**

| SHA      | Subject |
|----------|---------|
| `500d4ea6` | endpoint-ipc: remove operator:scan from IPC allowlist (side-effect bypass bug) |
| `960c4d2d` | audit pass 2: three real bugs found and fixed |
| `403a9cd2` | audit pass 2: signal propagation + IPC workspace resolution |
| `4f5d9d87` | audit pass 3: tools/list crash + wire-kind mismatches |
| `b98a5c9e` | audit pass 5: binary-over-HTTP encoding + wall-clock timer unref |
| `d53f46e7` | audit pass 6: binary corruption over MCP + wire-kind dispatch DRY |
| `95e6fc2f` | audit pass 7: extract emitToSseSink + apply to all 5 migrated routes |

**Risk:** Low to medium. Each commit message documents the bug it
fixes. Audit pass 3 includes one CRITICAL fix (tools/list 500 at
boot when `dev:ipc_echo` registered). Tests cover every fix.

**Rebase strategy:** these were chronologically interleaved with
PR 1-4 but the *files* they touch are all in PR 1-4's scope. Two
options:
- **(a)** Squash each audit pass into the PR it amends (more surgery
  but cleaner history).
- **(b)** Ship as one "post-merge audit fixes" PR after PR 1-4
  (less surgery, history shows the audit timeline).

(b) is the pragmatic choice. The bugs were real but interlocked —
reviewing as one chunk is easier than tracing each fix back to its
PR.

---

## PR 6 — Deferred items

**Theme:** Everything filed as "deferred" in the original audits.
**Commits (10):**

| SHA      | Subject |
|----------|---------|
| `7fbed516` | deferred-PR C: test infrastructure for 3 untested code paths |
| `b3db6324` | deferred-PR A: safety hardening (items 2 + 3) |
| `fb5a5952` | deferred-PR D: cleanup (items 8, 9, 10, 11) |
| `29e4519e` | deferred-PR B: extract PROJECTED_DEPS + wire IPC server telemetry |
| `73c34f49` | deferred-PR E: ipc-stream.ts base64 decode works in Node too (item 13) |
| `187c795e` | deferred-PR F: cross-transport binary envelope unification (item 14) |
| `06967ec1` | docs(plans): handoff doc for SSE/typed-events/IPC work |
| `cb3200e3` | tool_invocations.transport column + plumb through every transport |
| `0f04c7fc` | docs: handoff doc — close transport-column gap, update follow-ups |
| `7f9a2c35` | dev: /dev → Sessions + Telemetry filter by transport |
| `00d91054` | operator:scan: fully self-contained, IPC-allowlist eligible |
| `41ccb211` | endpoint-ipc: real-tool E2E test against actual registry |
| `4185b580` | docs: handoff doc — close all three deferred items |
| `5ac4a107` | docs(plans): PR-split plan for the 51-commit branch |
| `2e440f7f` | db(submodule): apply-058 script + bump pointer; docs: close last item |
| `eb01030f` | architect:chat + brainstorm:chat: IPC-allowlist eligible |

**Companion PRs:**
- `papercusp#sse-typed-events-transport-column` — adds the
  `transport` column to `harness_shared.tool_invocations`. Must
  merge before PR 6 lands so the column exists when the operator
  code starts writing to it.
- `papercup-desktop` PR 6 add-on:
  - `b4a231d` endpoint-ipc: per-call backpressure cap (10k events)
  - `544a5e1` verify-desktop-ipc.sh: runbook for end-to-end IPC verification

**Risk:** Medium. The largest commit (`00d91054`) refactors
operator:scan substantially. The IPC allowlist gains `operator:scan`
in this PR — verify the run.sh-shaped scan flow still works on
staging before merge.

---

## Cross-repo merge sequence

The strict ordering for ship day:

1. **`papercusp#sse-typed-events-transport-column`** — applies
   migration `058-tool-invocations-transport.sql`. Run `psql -f`
   against the live DB during merge. Column is additive + NULL-able
   so safe to land before any operator code starts using it.

2. **`papercup#PR-1` (wire-format)** — purely refactor; no schema
   dependency.

3. **`papercup#PR-2` (framework)** — depends on PR 1 only.

4. **`papercup#PR-3` (migrations)** — depends on PR 2.

5. **Lockstep:**
   - `papercup#PR-4` (IPC infra)
   - `papercup-desktop#sse-typed-events-ipc`
   - Submodule pointer in `papercup` PR 4 updates to the
     `papercusp` `transport-column` commit.

6. **`papercup#PR-5` (audit fixes)** — clean up after PR 1-4 land.

7. **`papercup#PR-6` (deferred items)** — must follow PR 5 and the
   `papercusp` submodule PR.

---

## Validation before each merge

Each PR should run before merging:

```bash
# papercup repo
npm test -w @papercusp/agent-mcp       # 116/116
cd apps/operator && npx vitest run \
  lib/endpoint-ipc/ lib/transport-adapters/ \
  lib/agent-tools/__tests__/ lib/agent-tools/dev/__tests__/ \
  "app/api/[transport]/" "app/api/agent-tools/[...path]/route.test.ts"
# 116/116

# papercup-desktop repo (PRs 4, 6 only)
cd src-tauri && cargo test --bin papercusp-desktop endpoint_ipc
# 22/22
./bin/verify-desktop-ipc.sh
# (interactive — confirms end-to-end live)
```

Pre-existing failure (NOT from this branch):
`apps/operator/lib/agent-tools/projects/__tests__/projects.test.ts >
projects:list > throws when no slug available`

---

## What this doc deliberately omits

- **Squash strategy per PR** — each PR can be squashed if reviewer
  prefers, or kept as a multi-commit topic branch. Up to the
  merging engineer.
- **Specific git commands** — `git cherry-pick`, `git rebase
  --onto`, etc. depend on local workflow preference. The commit-list
  + ordering is the canonical contract.
- (nothing — all four remaining migrations landed on this branch.
  `architect:chat` + `brainstorm:chat` at `eb01030f`,
  `operator:delegate` at `ad5ca1a3`, `operator:converse` at the
  commit following this docs update.)
