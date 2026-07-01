---
rel_path: "memory/raw.md"
updated_at: 1782869008170
_body: "content"
---


[2026-06-14T13:30:00Z] worker EI-9: headless zellij `pipe --plugin` companions get a focused FLOATING pane by default (zellij 0.44.3 floating_plugin default) — call hide_self() (SuppressPane, permission-free) in load() to suppress it; when it's the only float, zellij also hides the float layer + returns focus to the tiled pane. An external `toggle-floating-panes` on a ready-event RACES pane creation; hide_self() from inside load() + a one-shot retry on first PaneUpdate is the reliable fix.

[2026-06-22T22:08:00-04:00] worker EI-2535: "Stranded plan-item" reports — distinguish the leased CLAIM (plan_item_claims, mig 141) from the durable ASSIGNMENT (plan_item_assignments, mig 140). The stale-claim sweep (in-process-periodic.ts, 60s, self-re-arms on process start) reaps work-item claims + plan-item CLAIMS + issue claims, but plan_item_assignments NEVER auto-expire BY DESIGN (mig 140: survives sleep/interrupt, only released_ts clears it). A stranded assignment to an ephemeral su-… session-id that never re-adopts a stable name is a real class gap, but auto-reaping it is a breaking change to a documented claim/lock-authority invariant → architect decision, not an auto-implement fix.

[2026-06-30T16:34:00Z] worker EI-5454: the `stalled-feature` watchdog (collectStalledFeatureSignals, watchdog.ts:1437) chronically over-fires on the papercusp HOME harness — its body text + model assume the RETIRED legacy autoloop (bp-schedule/orchestrator dispatch), but live dispatch is Queen/fleet on-demand placement which doesn't auto-drain `todo` features, so a standing todo backlog is normal not a failure. It also treats source_plan=NULL features as always-dispatchable, ignoring payload.plan_item coverage to non-started plans. Fix lives in the self-improvement loop's own code → STOP/needs-human for the auto-implement role; don't re-attempt as an auto-fix.

[2026-06-30T21:19:00Z] worker EI-5842: prior implement attempt landed the overwatch-404 fix as UNCOMMITTED working-tree edits (loop.ts+loop.test.ts) but never called improvements:resolve, so the cadence re-dispatched. Lesson: check git diff/working-tree AND the test file before re-implementing; a re-dispatched bug may already be fixed-but-unresolved. For a multi-part bug ticket, resolve honestly (needs-human here: only the pinned code bug #4 was auto-fixable; #1/#2 gym-vs-plan routing = owner design decision, #3 bee infra-loss overlaps reaper work).

