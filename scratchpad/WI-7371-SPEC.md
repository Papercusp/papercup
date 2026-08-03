# WI-7371 — live total memory + CPU stats (Task Manager dropdown + admin page)

> Durable copy of the build spec. Written to a FILE because the papercusp-su MCP went
> unresponsive (`work_items:checkpoint` and `work_items:get` both timed out at 300s,
> and a direct `/api/mcp` curl timed out at 40s while `/api/health` answered in 1.4ms).
> Re-post this onto WI-7371 as a checkpoint once MCP recovers.

**Owner directive** [owner 2026-08-03], verbatim:
> "Add a live updating total memory usage and total cpu usage stats to the top of the
> task manager dropdown and the admin page."

## The two surfaces — RESOLVED, do not re-derive

1. **DROPDOWN** — `apps/operator-vite/src/components/adv/TasksRunningPill.tsx` (header pill)
   lazy-loads (`:49`) **`apps/operator-vite/src/components/adv/TasksRosterPanel.tsx`**.
   The panel header `<dl>` (~`:278`) already renders `data.summary.total` as "Enrolled".
   Rows already render `fmtBytes(r.rssBytes)` (~`:341`). **Totals go in that header dl.**
2. **ADMIN PAGE** — `apps/operator-vite/src/routes/admin/tasks.tsx` (`:3`) imports
   `TasksClient` from `@/app/admin/tasks/TasksClient`, i.e. it REUSES
   **`apps/operator/app/admin/tasks/TasksClient.tsx`**. Edit that one component.
   `<h1>Task Manager</h1>` ~`:288`; row count `{data?.summary.total ?? 0} row(s)` ~`:358`.

⚠ That `@/` import is the operator-vite cross-tree alias AGENT-ENV.md warns about. The file
lives under `apps/operator/` but is LIVE (operator-vite imports it) — editing it is correct.
It is NOT the retired standalone webapp path.

## Data source — SERVER SIDE

Add the aggregate to `summary` in **`packages/operator-core/lib/task-manager/inventory.ts`**:
- fold at ~`:229-250` (already builds `byState` / `byClass`)
- widen the `summary` type at ~`:86`
- update the `disabledInventory()` zero-value at ~`:112` or the type breaks

Both surfaces read the SAME `queryName: 'taskManager.inventory'`, so one resolver change
feeds both — and that is **required for correctness**, not convenience: `TasksRunningPill`'s
own doc comment records **WI-6844**, where the pill and its panel disagreed because each
derived its own number. Per-surface derivation would re-introduce that bug.

**Do NOT compute client-side from `rows`.** The pane filters by class/state and `rows` is a
projection — `rows.reduce()` would total only the *visible* subset while being labelled a
system total.

## The CPU trap — read before writing the label

`cpuUsec` (`inventory.ts:41`) comes from `cgroup-read.ts:133`
`parseCpuStatUsageUsec(cpu.stat)` → `usage_usec`, a **monotonic cumulative counter**, NOT a
rate. Summing it yields lifetime CPU-microseconds. Labelling that "CPU usage" is wrong.

Pick one and label honestly:
- **(a)** cumulative sum, labelled "CPU time" — trivial, honest, less useful.
- **(b)** a RATE: keep previous total + timestamp, emit `Δusec / Δwall_usec * 100` = cores-busy %.
  The reconcile tick runs every 30s (`DEFAULT_INTERVAL_SEC = 30`, `seed-task-reconcile-routine.ts:36`).
  ⚠ If (b), the watermark must **NOT** be a module-scoped `let` — that is exactly
  **EI-19407950136194410**, fixed earlier today in this same subsystem (a module-scoped
  counter resets on every process start, so it silently never fires under host churn).
  Persist it, or accept a null first sample.

Memory has no such problem: `rssBytes` is a gauge, so a sum is meaningful. But note in the UI
that summing RSS across processes double-counts shared pages — measured today, a naive
postgres RSS sum reported **403 GB on a 257 GB box**.

## Live-updating

Free — `useSyncQuery` re-renders on invalidation. Add **no** polling and **no** `setInterval`
(`lint:no-raw-setinterval`, empty baseline).

## Acceptance

- Totals reflect the FULL tracked set, provably independent of the active filter.
- Memory and CPU labelled unambiguously (gauge vs cumulative vs rate).
- Both surfaces read the same `summary` fields — they cannot disagree (WI-6844).
- Unit test on the aggregation fold incl. NULL `rssBytes` / `cpuUsec` rows (both `number | null`).
- `npm run lint:tsc -- --files=<changed>` clean; `npm run test:file` green.
- UI verified in the Tauri shell per `/internal/docs/testing/agent-e2e`. This is a UI change, so
  `verifiedHow:'live-drove-ui'` **requires a real capture/screenshot artifact** — a completion
  claiming it without one is REJECTED (happened to me on WI-7306 today).

## Motivating data (measured 2026-08-03, for the PR body)

- 15 window-dead terminal scopes hold 67 procs / **4.8 GB**, oldest 16–24 days.
- 36 `hono-host.mjs` procs / **34.7 GB** vs `PAPERCUSP_EXPECTED_OPERATOR_PROCS=6`.
- 121 `msedge` / **27 GB**, 109 under one parent, oldest 2.2 days.
- None of it is visible anywhere in the UI today.
