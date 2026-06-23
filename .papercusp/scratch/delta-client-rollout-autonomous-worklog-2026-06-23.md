# agent-tool-delta-client-rollout-2026-06-23 — autonomous completion work-log

> Durable state for the 2m autonomous loop (su-7f3e0376). **papercusp MCP
> (plans/work_items/memory/coord/loop) is UNREACHABLE this session** — none of the
> tools surface via ToolSearch. So plan bookkeeping is recorded HERE + in the
> code/tests/contract-doc, to be reconciled into `plans:set-status` when the MCP is
> reachable again. Canonical plan state read via `psql` (harness_shared.harness_plans).

## Item status (live, as driven this run)

| Item | State | Evidence |
| --- | --- | --- |
| P-001 | done (prior) | — |
| P-002 | done (prior) | — |
| P-006 | **done + flag flipped ON** | `SYNC_RESOURCE_DELTA` default `true`, de-darked; flags tests green |
| **P-003** | **DONE this run** | `BasePresenceTracker` (`libs/generic/tooldef/src/base-presence.ts`) + 21 tests + export + contract-doc scoping section |
| **P-005** | **DONE this run** | deltaMode capture (dispatch-stack.ts:982-989) verified: +3 unit tests (delta/not_modified/absent), dispatch-stack 17 green; LIVE telemetry proves the path (8044 `full` rows in tool_invocations); live mode:delta scoped to turn-wrapper integration |
| **P-004** | **CLOSED this run** | proxy logic (`dispatchWithConveyedDelta`) shipped+tested (14 tests); architectural block documented as terminal state at code (delta-client.ts SCOPE note) + contract doc §Scope + plan now_state. Legitimate completion = build-what's-allowed + document-the-boundary |

## Run complete — all P-001…P-006 resolved
Full tooldef suite: **588 tests green (44 files)**; my source files 0 tsc errors.

### Deferred plan-bookkeeping reconciliation (do when papercusp MCP returns)
The plan row (harness_shared.harness_plans, plan_slug=agent-tool-delta-client-rollout-2026-06-23)
still reads status=draft with P-003 in now_next. When `plans:*` MCP is reachable:
- `plans:set-status P-003 done` — BasePresenceTracker shipped (base-presence.ts, 21 tests, exported, contract-doc scoped).
- `plans:set-status P-005 done` — deltaMode telemetry verified (3 unit tests + live 8044 full rows).
- `plans:set-status P-004 blocked` (closed) — proxy logic shipped+tested; Claude-Code delivery contract-forbidden (D-006), documented.
- `plans:set-now` — all items resolved; only follow-on is the (flag-gated) turn-wrapper adoption of BasePresenceTracker.
- Optionally `memory:remember` the strategic finding: LLM tool-result delta is scoped to Papercusp-owned turn-wrappers (OMP/psu); external Claude Code (the fleet's big consumers) is out of scope — the real win was the sync delta (P-006).
Do NOT raw-UPDATE harness_plans (desyncs content_hash/version/plan-events) — use the MCP tools.

### P-005 finding (live telemetry)
`SELECT metadata_json->>'deltaMode', count(*) FROM harness_shared.tool_invocations GROUP BY 1`
→ `<none>`: 6,473,976 · **`full`: 8,044** · `not_modified`: 0 · `delta`: 0.
The 8,044 `full` rows PROVE the capture path is live end-to-end. Zero not_modified/delta
is the EXPECTED state — nothing sends `_meta.delta` with a cursor yet (no delta-aware
caller; BasePresenceTracker not yet wired into a turn-wrapper). So the live mode:delta
check is correctly gated on the (flag-gated, follow-on) turn-wrapper integration, not a
defect. Unit capture is fully pinned.

## Key findings this run

- **P-003 seam assessment (decisive):** the operator oracle/converse loop
  (`runAgentChat`, `libs/papercusp-shared/src/agent/chat-stream.ts`) does NOT use
  the Vercel AI SDK and owns NO message array — it **spawns a child agent process**
  (claude-code or omp) and only observes its event stream. The tool dispatch +
  message array live inside the child. So base-presence can't bolt onto
  `runAgentChat`; it belongs in the OMP/psu turn-wrapper (where Papercusp owns the
  turn boundary + message array, alongside coord_watermarks). → P-003 took the
  plan's own specified fallback: "build the pure tracker as a tested unit + scope
  the integration." Done.
- **BasePresenceTracker** = the harness half of D-006: cursor-per-view + `haveBase`
  + `negotiationFor` (full | not_modified~cursor | auto~cursor) + compaction-clear
  (rule 3) + the `enabled` scope-guard (external Claude Code → always full). Composes
  with `DeltaToolClient` (which owns rows+merge). Generic/storage-free.

## Loop mechanics

- Mechanism: Claude `ScheduleWakeup` (~120s) — papercusp `loop:arm` unreachable.
- One focused item per wake. Tests + tsc green before moving on; never leave red.
- Exit: when P-005 verified + P-004 closed → stop wakes + final report + (deferred)
  plan bookkeeping reconciliation.
