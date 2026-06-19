# Brief AB — Real-world collaboration E2E journeys

**Priority: S2 lane (S1 for a broken core journey).** Desktop E2E (Tauri) + LLM-scenarios.
The end-to-end HUMAN story, driven like a user.

## Objective
Drive the complete **two-people-collaborate-in-a-shared-hive** journey through the real
desktop UI, from onboarding to contribution to error recovery — proving the experience
holds, not just the API/substrate.

## Why it matters
Waves 1–4 prove the substrate + specific UI surfaces (G-004 status). But a public
release is judged on the END-TO-END journey a real user takes, and UI-only / sequencing /
guidance failures don't show in API tests: a join that "succeeds" but the hive never
appears, a sync that stalls with no in-app cue, an onboarding dead-end. Brief M's
`agent-e2e` playbook + the G-004 surface exist to make exactly this drivable; this lane
walks the whole path as a user would.

## Scope / scenarios (drive the real Tauri shell, headless Xvfb, never :0)
1. **Onboarding — discover + join a public hive:** a fresh user opens the discover panel,
   finds a public hive, joins it, and SEES the existing content backfill + the live
   federation status (G-004) reflect a real connection. Assert each step's DOM/screenshot.
2. **Two-user collaboration:** user A (owner) + user B (member) on two shells; A creates
   content → it APPEARS in B's UI (not just B's PG); B contributes → A sees it. The full
   round-trip through the rendered app, with the cost/sync indicators updating.
3. **Share flow honesty (consumes G-001/G-002/G-004):** A shares a hive (public + invite);
   the dialog shows honest reach (`reachablePeersForHive`, not global); a dead invite
   secret shows honest failure copy, not "appears shortly".
4. **Error-recovery UX (the trust test):** induce the failure modes — join a withdrawn/
   dead hive, a stalled outbox (EI-1618), 0-peer publish — and assert the UI gives a
   HONEST, ACTIONABLE signal (not a silent green "healthy" or a fake success). This is
   where U's drain signal + L's honest copy must surface to the user.
5. **Multi-hive UI:** a user in 2+ hives — switching, per-hive status, no cross-talk.

## Method
- `apps/operator/e2e/*.spec.ts` (Playwright via tauri-driver) for the automated path +
  the `tauri-agent-tools` agent-e2e playbook for ad-hoc; LLM-scenarios for the
  judgement-heavy "is this UX honest/clear" checks. Capture DOM + screenshot evidence per
  step (silence ≠ success). Two shells = two `PAPERCUSP_WORKSPACE_ROOT` on two Xvfb.

## Deliverables
- `findings-AB.md`: per-journey PASS/FAIL with evidence, any UI-only / sequencing /
  dishonest-signal bug (the class API tests miss), and the error-recovery verdict.

## Done / verdict
GREEN only when onboarding→join→collaborate→see-others works end-to-end through the real
shell with positive evidence, AND every failure mode surfaces an honest, actionable signal.
