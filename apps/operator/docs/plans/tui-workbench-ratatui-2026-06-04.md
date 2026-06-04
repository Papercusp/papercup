---
title: SP-TUI — ratatui terminal workbench (advanced-user surface, ports /adv)
slug: tui-workbench-ratatui-2026-06-04
status: ready
created: 2026-06-04
updated: 2026-06-04
owner: aviynw3@gmail.com
---

# SP-TUI — ratatui terminal workbench (advanced-user surface, ports /adv)

## Now

**State:** Autonomous loop, iteration 7. **P1 Create tab FULLY COMPLETE + polished + tested — `cargo test` 28/28 green, 0 warnings.** This iteration: launch keybinding (`n` in Sessions → `Action::Launch(PaneSpec)` → `Zellij::open_pane` best-effort in `main`; `App::launch_spec` reuses the selected session's agent else claude — unit-tested); **session dossier** pane (Sessions split into list + dossier: intent/role/feature/files/heartbeat/liveness/plan); **help overlay** (`?`, any key closes) + **command palette** (`:`, captures input, Esc/Enter close, Backspace) rendered as centered popups (`Clear`) over the body — all snapshot/behaviour-tested. Create-tab feature set: Plans (list+detail), Inbox (list+preview, needs-human flag), Sessions (roster list + dossier + launch), tab switch 1/2/3, j/k nav, help, palette, live poller (plans+roster+attention). 28 tests across app(12)/models(4)/client(3)/mux(2)/ui(7). Standalone crate, no workspace → can't break peers.

**Next:** P2 Harnesses tab: probe features/issues endpoints (grep apps/operator-vite FeaturesPanel/IssuesPanel data hooks) → add a 4th tab with features + issues lists + detail. Defer agents/logs/overview/chat (logs+chat need a Rust SSE client — bigger sub-step). Keep cargo green + 0 warnings + tested each step.

## Background — what this is and how it reshapes the roadmap

Decided in brainstorming: the **advanced-user surface becomes a terminal-native TUI**, not a GUI. Rationale: the audience is terminal-comfortable; native `claude`/`codex`/`omp` must run with full fidelity (the "don't be OMP" rule — never wrap/reimplement the agent); and ~85% of the existing `/adv` console is lists/tables/markdown/streaming-text that is as good or better as a TUI.

This **replaces the GUI-for-advanced-users direction** and reshapes the parent roadmap (`operator-core-headless-serve-2026-06-04`, the "Papercusp in vanilla Claude Code" arc):

- **SP1 (operator-core / `papercusp serve`)** — unchanged and still the keystone. The TUI is just another client of it.
- **SP3 (Claude Code plugin)** — unchanged. Native claude in a workbench pane loads the plugin; the workbench and the plugin are complementary (the workbench is the *human's* HUD, the plugin is the *agent's* substrate access).
- **SP5 (UI client)** — this plan **is** the new SP5. The browser SPA / Tauri GUI demote to optional/fallback; the TUI is the primary advanced surface.

Scope calls already made: **skip Brainstorm** (the lone pixel-only feature — dropped from the advanced surface); **Git tab = a 3rd-party TUI** (`lazygit`/`tig`/`gitui`) launched in a pane, not reimplemented; **everything else ported TUI-native**. The **Create tab is first and most important.**

The `/adv` map this ports (verified during scoping): a 9-tab dockview console (`operator-vite/src/routes/adv/index.tsx`, `AdvShell.tsx`), state URL-backed (nuqs), data via `@papercusp/sync` + 3s polling + SSE for logs/chat. Crucially the **data logic is already separated from rendering** (`plans-api.ts` hooks; pure `applyRosterFilters`/`groupRoster`/`buildFilesInPlay`; `scope.ts`) and the **launcher already goes native** (`/api/adv/sessions/launch-su` → `launch-agent.ts` → `psu` → records an `adv_sessions` row + spawns a native terminal).

## Goals

- A **`pui`** TUI binary (Rust/ratatui) that renders the advanced-orchestration HUD and **launches/monitors native agent sessions in real zellij panes** — full CLI fidelity, keyboard-driven, SSH-able.
- **Full functional parity with `/adv`** minus Brainstorm, with Git delegated to a 3rd-party TUI.
- A faithful **Create tab** (plans / inbox / sessions) as the first shippable increment.
- The TUI is a **thin client of the backend HTTP/SSE API** — no business logic duplicated; same endpoints `/adv` uses.
- Distributable as a per-platform binary via SP4's pipeline; pairs with SP1's `papercusp serve` singleton.

## Non-goals

- Re-implementing the agent CLIs or embedding a terminal emulator we maintain (we ride zellij instead). `tui-term`-style in-app PTY embedding is explicitly avoided.
- Brainstorm canvas, interactive git-graph viz (use 3rd-party), and rich charts beyond what ratatui's `Chart`/`Sparkline` give — the visual minority stays out (or a tiny optional GUI pop-out, deferred).
- Replacing the desktop GUI on day one — it coexists as a fallback and is sunset only after parity (Phase 5).
- The backend work itself (SP1) — this plan consumes it; early phases target the **currently-running** operator so TUI work proceeds in parallel with SP1.

## Architecture

- **A1 · Ride zellij for agent panes (decided; not embed).** Native `claude`/`codex`/`omp` run in real zellij panes → perfect fidelity. The TUI's job is to render the HUD and *drive* zellij (open/select/kill panes via its action/plugin API) + monitor via the roster API; ship a default **KDL layout** = HUD pane + agent panes. A thin internal `Multiplexer` trait keeps a tmux impl possible later, but **zellij is the target**.
- **A2 · ratatui app architecture.** ratatui is immediate-mode, so we impose our own structure: a single `AppState`, an `Event` enum (input + async backend messages + timer ticks) drained from an mpsc channel into one `update(state, event)`, then `draw(state)` each frame. tokio runtime; input via crossterm event stream; backend polling/SSE tasks post `Event::Backend(..)` into the channel. (Evaluate `tui-realm` as an optional Elm-like layer in P0; default is hand-rolled to keep control.)
- **A3 · Backend client crate.** A typed async client (`reqwest` + `serde`) that resolves the operator URL + token from `~/.papercusp/operator.json` (SP1) with a dev fallback to the existing discovery + `~/.papercusp/superuser-token` — and for now **targets the currently-running operator**. Wraps the `/adv` endpoints; exposes a polling/SSE subscription abstraction that emits `Event::Backend`.
- **A4 · Where it lives + name.** New Rust crate at `apps/tui/` (cargo); binary **`pui`**. On launch `pui` ensures `papercusp serve` is running (SP1 singleton, once available) then opens the workbench; during early development it points at the already-running operator.
- **A5 · Styling/UX system.** A central theme module (a Lip-Gloss-equivalent: colors from the brand/design-phase tokens, borders, status colors), a global key-binding + help-overlay system, a command palette primitive, a status bar — all built once in P0 and reused by every panel. Markdown rendering, text editing, etc. via crates chosen in P0 (candidates to confirm: a markdown→`Text` renderer or shell to `glow`; `tui-textarea`/`$EDITOR` for editing; `throbber-widgets-tui` for spinners; `ratatui-image` only if a pop-out is ever needed).
- **A6 · State & agent-driveability.** `/adv` keeps user-meaningful state in nuqs so agents can drive it via `ui:dispatch`. The TUI has no URL; equivalent control surface is deferred (a future `tui:dispatch`-style endpoint or an MCP control channel) — out of scope here, noted so we don't lose it.

## Phase 0 — Foundations & spike (de-risk the unknowns)

- **P0-1 zellij spike.** From a controlling Rust process, launch a native `claude` in a zellij pane; verify fidelity (alt-screen, mouse, resize, focus) and the ability to open/select/kill panes programmatically + ship a default KDL layout. Confirm the action/plugin API surface we need. (Validates A1.)
- **P0-2 Crate scaffold.** `apps/tui/` cargo crate building the `pui` binary: ratatui + crossterm + tokio + reqwest + serde. App skeleton implementing the A2 loop (state/event/update/draw) with a trivial screen.
- **P0-3 Backend client + discovery.** Implement A3: resolve url+token (operator.json + dev fallback, targeting the running operator), typed calls for `/api/adv/roster` and `/api/admin/plans/list`, an async poller emitting `Event::Backend`. Prove a live read against the running operator.
- **P0-4 UX kit.** Theme module (design-phase tokens), key-binding/help system, command palette, status bar, left-list+right-detail split layout primitive. Pick + confirm the markdown/editor/spinner crates.
- **P0-5 Test harness.** Headless render tests via ratatui `TestBackend` (assert buffer snapshots); a fake backend server for client tests. CI target.

## Phase 1 — Create tab (first + most important)

Lazygit-shaped: header (harness selector + scope) · left list · right detail/roster · view switcher (plans/inbox/sessions) · `/` filter · `:` command palette · status bar (now-running pills).

- **P1-1 Shell.** Header (harness selector from `/api/harness/projects/lite`, scope expanded/self/all), tab strip (Create active; others stubbed), status bar (`AdvNowRunning` equivalent: live run pills + alive dot + "N plans waiting"). Keyboard nav between regions; command palette; filter.
- **P1-2 Plans view.** Plan list (left, bucketed/colored by status: started/running/done/reviewing/archived) + plan detail (right, markdown). Actions: open, **edit via `$EDITOR`**, launch, replan, promote, archive. Data: `/api/admin/plans/list`, `/api/admin/plans/<slug>`; mutations to the same endpoints.
- **P1-3 Inbox view.** Filtered item list (Needs-Human / ToDos / Blocked / Escalations / Messages / Reviews) + preview + actions (done / tag / note / escalate / resolve). Data: plan-items + `coord` endpoints. Filters mirror `?iStatus`/`?iTag`/`?q`.
- **P1-4 Sessions view (roster).** k9s-style table polling `/api/adv/roster` every ~3s: liveness dot, client badge, role, feature, label, current-files (first 6 + overflow), relative time. Filters (client/liveness/role/file/show-stale). Detail dossier pane (overview/context/files/history). Reuse the pure filter/group logic shapes from `SessionsRosterView`.
- **P1-5 Launch + control flow.** Pick agent (claude/omp/codex) + harness + plan + model → `POST /api/adv/sessions/launch-su` → agent opens in a **zellij pane** (per A1) and appears in the roster. Session actions: kill (`/api/adv/sessions/:id/kill`), focus/attach (select the pane), view transcript. (Confirm the launch endpoint still routes through `psu`, not the retired `*-su` wrappers.)
- **P1-6 Tests + verification.** Render-snapshot tests per view; client tests vs the fake backend; a live smoke against the running operator (list plans, open one, launch a throwaway session into a zellij pane, see the roster row, kill it).

## Phase 2 — Harnesses tab

Port the dockview panels as a tiled/tabbed layout: **Features** (queue list + status), **Issues** (severity list), **Detail** (markdown reader), **Agents** (run table + kill), **Run log** (SSE stream — terminal-native), **Overview** (status buckets + phase tabs + cost), **Contributors**, **Chat** (SSE streaming chat + tool-call rendering; the most novel TUI piece). Data: per-harness sync endpoints + the two SSE streams.

## Phase 3 — Docs / Testing / Config / Settings tabs

- **Docs:** file tree + markdown reader + search (`/api/harness/:slug/docs`).
- **Testing:** test registry + runner + streaming output (terminal-native).
- **Config / Settings:** field forms (TUI form widgets) + `$EDITOR` for JSON/YAML; members/keys/phase-promotion. Validation against the existing schemas.

## Phase 4 — Git (3rd-party)

Wire a launcher that opens `lazygit` (or `tig`/`gitui`) in a zellij pane scoped to the selected harness's repo/worktree. No reimplementation; optionally a thin status line. Pick the tool in this phase.

## Phase 5 — Integration, distribution, GUI sunset

- Default **zellij layout** shipped (HUD pane + agent panes) for a one-command integrated workbench.
- Wire to SP1's **`papercusp serve` singleton** (ensure-running on launch via `serve --ensure`).
- **Packaging:** per-platform Rust binary (`pui`) through SP4's release pipeline.
- Theming polish from design tokens; help overlay; performance pass on dense tables.
- **Sunset call (open decision):** retire the GUI `/adv` for advanced users once parity holds (keep desktop as a fallback host or drop — decide at this point).

## Testing strategy

- **Unit/render:** ratatui `TestBackend` buffer snapshots per panel; pure-logic unit tests (filters/grouping/scope).
- **Integration:** client crate against a fake backend server; the zellij driver against a real zellij in CI (headless).
- **Live smoke:** against the running operator (and later a clean `papercusp serve`) — the Phase 1 end-to-end smoke above.
- Follows the repo's canonical homes where applicable; Rust tests via Cargo.

## Risks & mitigations

- **zellij integration depth (A1).** zellij's plugin/action API may not expose everything cleanly. Mitigate: P0-1 spike validates before committing further; the `Multiplexer` trait keeps a tmux impl as an escape hatch.
- **Scope size.** Porting 8 tabs is large. Mitigate: Create tab first delivers ~80% of value; later phases coarsen; each phase ships independently.
- **Endpoint drift / the `psu` vs `*-su` detail.** The `/adv` scouting saw a possibly-stale `*-su` reference. Mitigate: confirm `launch-agent.ts` routes through `psu` before P1-5.
- **ratatui ecosystem gaps (markdown/editor).** Mitigate: P0-4 confirms crates; fall back to shelling `glow` and `$EDITOR`.
- **Agent-driveability regression (A6).** The GUI is agent-driveable via nuqs+`ui:dispatch`; the TUI isn't yet. Mitigate: explicitly out of scope, tracked; revisit after parity.

## Open decisions

1. **GUI sunset (Phase 5):** retire the `/adv` GUI for advanced users once the TUI is at parity, vs keep it as a coexisting fallback. Decide at Phase 5.

## Decisions

### Advanced-user surface is a terminal-native TUI (not a GUI)
2026-06-04 — The advanced surface becomes a ratatui TUI that ports `/adv`. Audience is terminal-native, native CLI fidelity is required, and ~85% of `/adv` is TUI-friendly. This becomes the new SP5; the browser SPA / Tauri GUI demote to optional/fallback.

### Framework = ratatui (Rust)
2026-06-04 — Chosen over Bubble Tea (Go) and Ink (TS). Reasons: best-in-class dense-dashboard rendering + charts (Canvas/Chart/Sparkline), single bundled binary aligned with the Rust desktop and SP4's per-platform pipeline, max performance. The "Ink = React reuse" pull is illusory because any TUI is just a backend client (no render-code reuse). Cost accepted: assemble the app loop + a few crates (markdown/editor) ratatui doesn't bundle, and slower iteration than TS.

### Multiplexer = zellij; never embed a terminal
2026-06-04 — Native agents run in real **zellij** panes (perfect fidelity) rather than a `tui-term`-embedded PTY we'd have to keep faithful. zellij chosen over tmux for the tighter integrated KDL-layout + action/plugin API; a thin `Multiplexer` trait keeps tmux as a future escape hatch. This is the concrete "don't be OMP" mechanism and removes the dependency on the tiny/niche `tui-term`.

### Binary name = `pui`
2026-06-04 — The TUI binary is `pui` (crate at `apps/tui/`). `pui` ensures `papercusp serve` is running (SP1 singleton) and opens the workbench; during early development it targets the already-running operator.

### Develop against the currently-running backend
2026-06-04 — Early phases point the backend client at the currently-running operator (dev discovery + `superuser-token`) rather than waiting for SP1's `papercusp serve`. This unblocks TUI work to proceed in parallel with SP1; the client switches to `operator.json` resolution once `serve` lands.

### Scope: skip Brainstorm, delegate Git to a 3rd-party TUI, port the rest
2026-06-04 — Brainstorm is the only pixel-only feature and is dropped from the advanced surface. Git uses `lazygit`/`tig`/`gitui` in a pane. Plans, Inbox, Sessions, Harnesses (features/issues/detail/agents/logs/overview/contributors/chat), Docs, Testing, Config, Settings are ported TUI-native. Create tab first.

### TUI is a thin backend client; no logic duplication
2026-06-04 — The TUI calls the same HTTP/SSE endpoints `/adv` uses and resolves url+token from SP1's `operator.json` (dev fallback to current discovery). No business logic is duplicated in the TUI.
