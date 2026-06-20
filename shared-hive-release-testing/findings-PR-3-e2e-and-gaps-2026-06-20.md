# Findings — PR-3 live E2E + session gaps (2026-06-20)

Author: Claude Code agent (PR-1 implementer, then PR-3 verifier). Autonomous loop, owner asleep.
Coord note: the papercusp-su coord/memory MCP was **not reachable** from this Claude Code
session (no `coord:*` / `memory:*` / `plans:*` tools surfaced via ToolSearch), so this file is
my peer-visible handoff channel in lieu of `coord:send-message` / work-queue writes. A peer with
coord access: please mirror the **Proposed work items** below into the real queue.

## 1. PR-3 (report GUI + manual/auto modes) — VERIFIED ✅

PR-3 was already built by a peer (PrsTab/PrRow + `prs.ts` report+WI enrichment + owner-gated
auto-toggle). I verified it:

- **Unit/route (green):** `PrRow.test.tsx` (ReportPanel: summary/recommendation/risks/checksObserved),
  `PrsTab.component.test.tsx` (auto-toggle gating), `prs-hive-scope` + `pr-reviewer-settings` route tests.
- **Live GUI E2E (PASS)** — isolated Tauri instance on Xvfb `:90` via VirtualGL (`vglrun -d egl0`,
  real RTX 3090 GL), driven through the `tauri-agent-tools` bridge, **owner's window untouched**,
  all resources torn down. Evidence:
  - PrsTab mounts live in the **Git tab** (`tab=git` → `AdvGitDock` auto-opens `adv:prs` → `AdvPrsPanel` → `PrsTab`). DOM: `.pc-adv-prs` + `.pc-adv-prs__bar` present; title "Pull requests".
  - **Owner-gated auto-toggle: `aria-checked=false`, `disabled=true`, `.is-locked` true** for a
    non-owner viewer — the §3 gating + §4 honesty *teeth* (a non-owner literally cannot flip it;
    server-authoritative via `autoModeEditable`).
  - Filter + scope chips render (§5); honest empty-state "No PRs match this filter" (no false
    merged/approved); **zero console errors**; screenshot non-blank (real GL).
  - Not live-exercised: report-panel-with-data (§1) + manual approve buttons (§2) — papercup had
    **no open PRs**, so those remain covered by the green `PrRow.test.tsx` component test.

## 2. Gap FIXED this session (doc)

`apps/operator-docs/.../testing/agent-e2e.mdx` §15 — added a gotcha: **harness-panel tabs need a
warm single-pot context, and the PRs panel is NOT a standalone tab** (it's auto-opened inside the
Git tab; `?tab=prs` is strip-excluded and the router never honors the deep-link). Two-step nav:
warm `?tab=harnesses&slug=X&scope=expanded`, then switch to `?tab=git`. This cost me ~1h; the note
saves the next agent that time.

## 3. Proposed work items (for a peer with queue access, or me in a later loop)

- **WI(proposed, P2): guard against "shipped-but-vaporware" plan items (EI-479 class).** PR-1's
  P-042 was marked `✅ DONE` in `papercusp-dogfood-phase7-pr-lifecycle` with a file path
  (`apps/operator/lib/pr-host/poll-daemon.ts`) + "6 tests" that **never existed** — the single
  biggest inbound-PR gap hid behind a false status for weeks. Proposed: a lint/CI check (or a
  `plans:set-status` preflight) that, when a plan item is flipped to `shipped`/`done` and names a
  file path, verifies the path exists and the stated test file/count resolves; fail/warn otherwise.
  Bounded, high-leverage (catches the whole vaporware class). Needs peer consensus on home
  (lint:tests vs plans preflight) — flagging rather than solo-building a cross-cutting guard.
- **Note (P3, low conf): possible vestigial `?tab=prs` route.** `prs` is in `ADV_TAB_IDS` +
  `renderAdvTab` → `AdvHarnessPanelPage panel="prs"` (DIRECT.prs → PrsTab), but it's strip-excluded
  and the live surface is the Git-tab dock panel. The standalone route may be dead/duplicate.
  UNCONFIRMED — `?tab=prs` with warm-nav was not retested; do not remove without confirming no
  consumer deep-links it.

## 4. Status of the PR-system arc (fleet convergence, as observed)

PR-1 (poll daemon, mine) ✅ · PR-2 (agent-reviewer + report) ✅ peer · PR-3 (report GUI) ✅ peer
(verified above) · PR-4 (WI↔PR producer + identity + trailer) ✅ peer · PR-5 (live fork→PR dogfood,
`platform/dogfood_verify.ts`) ◐ peer-active. operator-core PR-system suite: 397 tests green.

## 5. UPDATE (later loop iter, 2026-06-20) — status-drift is SYSTEMIC, both directions

Strengthening §3's EI-479 proposal with more evidence gathered while looking for pickup work:

- **done-but-still-`todo` (causes fleet to redo work):** `WI-218` (U2 extract UI primitives) reads
  `state=todo, assignee=null` in the live queue, but the plan `operator-vite-ui-consolidation-2026-06-16.md`
  D-001 shows U2-1..U2-5 were **built + tested 2026-06-18** (`apps/operator-vite/src/components/ui/`).
  The queue item should be closed/re-scoped to "adoption." I also personally hit FOUR already-done
  items this session (PR-2, PR-3, PR-4, WI-218) before detecting they were done — real wasted scouting.
- **shipped-but-vaporware (causes gaps to hide):** P-042 (the whole PR-1 spine), per §3.

→ This is one gap with two faces: **plan/queue status is not reconciled against ground truth.** The
EI-479 guard should check BOTH directions: (a) an item flipped done/shipped that names a file/test path
must have it exist; (b) periodically reconcile queue `state` vs the owning plan's checkbox/status so
done-in-plan items don't linger `todo`. Still needs peer consensus on home (lint vs plans-preflight vs
a reconcile routine) — NOT solo-built (would be an unrequested cross-cutting mechanism). Filed here for
a peer with coord access; I could not reach coord/peers from this Claude Code session (papercusp-su MCP
absent; `:3270` coord writes 403 for unverified-loopback).

### Loop status (autonomous, owner asleep)
PR-1 ✅, PR-3 E2E ✅, agent-e2e doc gap fixed, this finding filed. No safe non-colliding pickup work
remains reachable (bounded queue work is fleet-done; the rest is high-collision/big-scope or
coord-gated). Posture: regression-watch my domain (pr-host) per-tick via tree fingerprint, re-running
the suite only when it moves (last: green @ tree 11fe2469a / 354 tests), and keep these findings sharp
for when a coord-capable peer can act on them.
