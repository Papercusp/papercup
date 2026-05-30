---
title: Workspace-scoped localStorage isolation (corrected)
slug: workspace-localstorage-isolation-2026-05-27
status: shipped
created: 2026-05-27
updated: 2026-05-30
owner: avi@storewolf.com
---

# Workspace-scoped localStorage isolation (corrected)

## Now

**State:** Draft. Rewrite of the "Complete workspace-isolation plan" after a
code audit (2026-05-27). The original was accurate key-by-key but had two
correctness gaps and a non-live target; this version fixes the workspace-id
*source* first, then scopes keys.

**Next:** human sign-off on D-001 (workspace-id source). Phase 1 is the
prerequisite for every later phase — nothing else is correct until the browser
can reliably name its workspace.

## Background

The Tauri webview loads the operator at a **fixed origin**
(`tauri.conf.json` → `frontendDist: http://127.0.0.1:3070`), identical across
every workspace. localStorage is keyed by origin, so **all workspaces share one
localStorage** — settings, layout, voice config, onboarding flags, and the
active-harness selection from workspace A are visible in workspace B. That leak
is real; the goal is to namespace every workspace-relevant key.

The predecessor plan ("Complete workspace-isolation plan") proposed prefixing
keys with `pc:ws:<id>:` where `<id>` comes from
`getBrowserWorkspaceId()` (reads `?ws=` from the URL). The audit confirmed its
per-key claims (all 21 named keys exist where stated; the 4 named test files
exist; `getBrowserWorkspaceId` exists privately in
`app/_components/voice/voice-mode.ts`). But it rests on three things that do not
hold:

1. **`?ws=` is not a reliable id source.** It is written only by the
   `WorkspaceSwitcher` reset URL (`/harness?ws=<id>`). The live operator-vite
   router has no `retainSearchParams`/default-search, so `?ws=` is dropped on
   the next client-side navigation; and a cold desktop launch loads
   `127.0.0.1:3070` with no `?ws=` at all. Net: `getBrowserWorkspaceId()`
   returns the real id only on the immediate post-switch page and otherwise
   falls back to `'default'`. Prefixing keys on top of that source makes
   settings flip scope mid-session and leaves both workspaces colliding under
   `pc:ws:default:` — i.e. it does not actually isolate.
2. **`harness.activeProject` was scoped in only 4 of 6 sites.** Mixing scoped
   writers with unscoped readers breaks the key entirely.
3. **Step 1 edited a non-live path.** The bootstrap scripts in
   `apps/operator/app/layout.tsx` are the **Next** operator's; the live UI is
   operator-vite, whose `index.html` has no such scripts (they are "NOT YET
   PORTED" per `operator-vite/src/routes/__root.tsx`). Editing `layout.tsx`
   changes dead-in-live code.

This plan fixes the id source first (Phase 1), then completes coverage.

## Goals

1. Every workspace-relevant localStorage key is namespaced per workspace, and
   the workspace id is available **on every page, cold-start included**, with no
   dependence on `?ws=` surviving navigation.
2. For each scoped key, **every** reader and writer is converted together — no
   partial scoping.
3. The set of intentionally-unscoped keys is **explicit and documented**, so the
   "no exceptions" claim is replaced by a real allowlist.

## Non-goals

- Data migration. Pre-alpha: keys silently miss on first load and fall through
  to PG (PG-backed) or reset to defaults (client-only). Acceptable.
- Scoping user-axis or global keys (welcome stamps, testing harness internals,
  third-party caches) — see "Deliberately unscoped".
- Fixing the unrelated FOUT/flash from the un-ported operator-vite pre-hydration
  bootstrap. Tracked separately.

## Phase 1 — Reliable workspace id in the browser (prerequisite)

The operator process is already workspace-specific (HOME-remapped per workspace;
`activeWorkspaceId()` resolves `registry.current`). Make it tell the browser.

- [todo] P-001: The SPA host (`host-spa.ts`, serves `index.html` from `PAPERCUSP_SPA_DIST`) injects `<script>window.__PAPERCUSP_WS__ = "<activeWorkspaceId()>"</script>` into the served HTML `<head>`. Mirrors the planned `window.__PAPERCUSP_FLAGS__` injection pattern.
- [todo] P-002: `getBrowserWorkspaceId()` precedence becomes: `window.__PAPERCUSP_WS__` → `?ws=` (back-compat) → `'default'`. URL-independent, survives all navigation, correct on cold start.
- [todo] P-003: Verify against the live desktop: cold launch into a non-default workspace, navigate across tabs, confirm `getBrowserWorkspaceId()` returns the real id throughout (not just post-switch).
- [todo] P-004: (Defense-in-depth, optional) add `retainSearchParams(['ws'])` + a root `validateSearch` carrying `ws` in operator-vite so `?ws=` also persists — keeps the URL honest for deep links, but P-001/P-002 are the load-bearing fix.

## Phase 2 — Shared utility: `apps/operator/lib/browser-workspace.ts`

- [todo] P-005: New module exporting `getBrowserWorkspaceId()` (moved out of voice-mode.ts with the P-002 precedence) and `wsLocalKey(key: string): string` → `pc:ws:<id>:<key>`.
- [todo] P-006: All callers compute keys at **call time**, never module-load (the id global/URL is read per call). Files holding the key in a module-level `const` today — `voice-mode.ts`, `shortcut-registry.ts`, `op-backstory-state.ts`, `NotificationCenter.tsx`, `visual-effects.ts` — must move the key computation into the function body.
- [todo] P-007: `voice-mode.ts` drops its private `getBrowserWorkspaceId` and imports the shared one.

## Phase 3 — Behavior-affecting settings

- [todo] P-008: `operator-shared-state.ts` — `operator:autoAccept` via `wsLocalKey`; legacy `operator:autoScan` read stays unscoped (one-time migration).
- [todo] P-009: `voice-mode.ts` — `papercusp.voice.config.v1` via `wsLocalKey` in `loadVoiceConfig()`/`saveVoiceConfig()`.
- [todo] P-010: `AudienceModeSelector.tsx` — `pc:audienceMode` via `wsLocalKey`.
- [todo] P-011: `visual-effects.ts` — `papercusp.visualEffectsMode` via `wsLocalKey` in load/save; also update the `storage` event-listener key comparison.
- [todo] P-012: `shortcut-registry.ts` — `papercusp.shortcuts.v1` via `wsLocalKey` in load/save/clear.

## Phase 4 — Layout / UI state + COMPLETE `harness.activeProject`

- [todo] P-013: `OperatorChatSidebar.tsx` — `papercusp.operatorChat.width` via `wsLocalKey` in read/write.
- [todo] P-014: `harness.activeProject` — scope **all six** sites together (audit gap #2): `HarnessDashboard.tsx` (r/w), `RecentActionsCenter.tsx` (r), `OracleDock.tsx` (r), `lib/admin-test-suites.ts` (r), **`apps/operator-vite/src/components/adv/AdvShell.tsx` (r/w, lines ~127/164/224 — the live `/adv` selector)**, **`apps/operator/app/admin/plans/PlansClient.tsx` (r, `ACTIVE_HARNESS_KEY`)**. The last two were missing from the predecessor and would have broken the key.

## Phase 5 — Notification watermark

- [todo] P-015: `NotificationCenter.tsx` — `papercusp.toastLog.lastSeen` via `wsLocalKey` in read/write. (Note: this value is also mirrored to PG via the operator profile `toast_last_seen_ms`; the localStorage miss falls through to PG.)

## Phase 6 — Tutorial / onboarding flags

- [todo] P-016: `VoiceButton.tsx` — `pc-voice-wake-hint-seen-v1`, `pc-voice-ptt-hint-seen-v1`.
- [todo] P-017: `OracleDock.tsx` — `oracle_seen_v1`, `papercusp_tutorial_done_v1`, `papercusp.tutorial.intent` (all reads/writes).
- [todo] P-018: `TutorialButton.tsx` — `papercusp.tutorial.intent` (write).
- [todo] P-019: `DockOnboarding.tsx` — `papercusp:dock-onboarded` (read/write/remove).
- [todo] P-020: `ProvisionalOwnerExplainer.tsx` — `papercusp.provisionalOwner.shown.v1` (read/write).

## Phase 7 — Backstory rate-limiting

- [todo] P-021: `op-backstory-state.ts` — `papercusp.backstory.recent` via `wsLocalKey` in `readKey/writeKey/removeKey('recent')`. `papercusp.backstory.session` stays in sessionStorage (per-tab) — leave it.

## Phase 8 — Per-harness-slug keys (two workspaces, same slug)

- [todo] P-022: `PiTerminalsDock.tsx` — `papercusp:pi-dock-layout:<slug>` → `wsLocalKey('pi-dock-layout:<slug>')`.
- [todo] P-023: `CollapsedRails.tsx` — `harness.git.lastSeen.<slug>` → `wsLocalKey('harness.git.lastSeen.<slug>')`.
- [todo] P-024: `ArchitectInbox.tsx` — `harness.threads.<slug>` → `wsLocalKey('harness.threads.<slug>')`.

## Phase 9 — Audit-found omission

- [todo] P-025: `lib/voice-engines/elevenlabs-conv.ts:144` — `localStorage.getItem('harnessElShellMode')` is a real unscoped key the predecessor missed. Either scope it via `wsLocalKey` or add it to the deliberately-unscoped allowlist (it's a debug/EL-shell toggle). Decide explicitly; don't leave it silently unscoped.

## Phase 10 — Bootstrap scripts (Next path only; live app is module-driven)

- [todo] P-026: `apps/operator/app/layout.tsx` `visualEffectsBootstrapScript` + `operatorChatBootstrapScript` — inline the two-line `?ws=`/global prefix and use the scoped key. **Note:** this is the **Next** operator path, not live. It matters only if/when these are ported to `operator-vite/index.html`; do that port + scope together, and have them read `window.__PAPERCUSP_WS__` (which exists at pre-hydration via P-001) rather than `?ws=`. In the live operator-vite app today, visual-effects + chat-width are applied post-mount by their modules (P-011/P-013), so Phase 3/4 already cover the live behavior.

## Tests

- [todo] P-027: Update the 4 mocked-localStorage tests to the prefixed format and stub the id source: `DockOnboarding.test.tsx`, `__tests__/OperatorChatSidebar.component.test.tsx`, `__tests__/ProvisionalOwnerExplainer.test.tsx`, `voice/voice-mode.test.ts`. Stub `window.__PAPERCUSP_WS__ = 'test'` (preferred) rather than only `?ws=`, matching the P-002 precedence.

## Deliberately unscoped (the real allowlist — replaces "no exceptions")

Verified during the audit as correct to leave alone:

- **User-axis, not workspace:** `papercusp_user_welcomed_<userId>` (`AutoLoginWelcomeToast.tsx`); cleared by prefix in `login/page.tsx` + `operator-vite/src/routes/login.tsx` — unaffected by this plan.
- **Testing-harness internals (global):** `papercusp.testing.chaos-runs.v1` (`recorder-channel.ts`), `papercusp.testing.perf-events.v1` (`vitals-recorder.ts`), `LiveMetricsTab.tsx`.
- **Third-party / disabled:** `MarkdownEditor.tsx` (Vditor's own cache, `enable:false`).
- **No real localStorage I/O (PG-backed or comments only):** `session.ts`, `operator-converse-tags.ts`, `dock-layouts.ts`, `operator-last-scan.ts`, `harness-fs-watcher.ts`, `settings/shortcuts/page.tsx` (delegates to `shortcut-registry.ts`). `papercusp.toastLog.lastSeen`/`papercusp.autoScan` in `session.ts` are historical comments — already migrated to PG.

## Migration behavior

No data migration. Post-change, keys miss on first load and fall through to PG
(PG-backed: toast watermark, profile-derived) or reset to defaults (client-only:
voice config, shortcuts, layout, onboarding). Pre-alpha — acceptable.

## File count

1 new (`browser-workspace.ts`) + 1 host edit (`host-spa.ts`, P-001) +
~22 edited source files (the predecessor's 20 + `AdvShell.tsx` + `PlansClient.tsx`
+ `elevenlabs-conv.ts`, minus the now-conditional `layout.tsx`) + 4 test files.
The predecessor's "1 new + 19 edited" undercounted.

## Decisions

### D-001 — Workspace id comes from a server-injected global, not `?ws=` alone

**Decided 2026-05-27.** The browser learns its workspace from
`window.__PAPERCUSP_WS__`, injected into `index.html` by the workspace-specific
operator host, with `?ws=` and `'default'` as fallbacks. Prefixing keys is only
correct if the id is right on every page; `?ws=` is not retained across
navigation and is absent on cold start, so a URL-only source silently collapses
scoping to `'default'`. The host already knows the active workspace
(`activeWorkspaceId()`), so injection is the robust, navigation-independent
source — and matches the existing `__PAPERCUSP_FLAGS__` injection pattern.

**Alternatives rejected:** `retainSearchParams(['ws'])` + desktop loading the
initial URL with `?ws=<current>`. Works but is two coupled changes (router +
desktop) and remains URL-fragile; kept only as optional defense-in-depth (P-004).

### D-002 — Scope every reader and writer of a key together

**Decided 2026-05-27.** Partial scoping is worse than none: a scoped writer and
an unscoped reader never agree. `harness.activeProject` must change in all six
sites at once (incl. the live `AdvShell.tsx` and `PlansClient.tsx` the
predecessor missed). Each phase item lists every site for its key.

### D-003 — "No exceptions" replaced by an explicit allowlist

**Decided 2026-05-27.** A blanket "every key, no exceptions" is wrong: several
keys are legitimately user-axis (welcome stamps), global (testing internals),
third-party (Vditor), or already PG-backed. The "Deliberately unscoped" section
is the canonical allowlist so future audits don't re-flag them and future keys
get classified on sight.

### D-004 — `layout.tsx` bootstrap is the Next path; the live app is module-driven

**Decided 2026-05-27.** The pre-hydration bootstrap scripts the predecessor
targeted live in the Next operator's `layout.tsx`, which is not the live render
path (operator-vite has not ported them). Scoping `layout.tsx` is parity-only;
the live visual-effects/chat-width scoping is carried by their modules
(P-011/P-013). When the bootstrap is ported to `operator-vite/index.html`, it
must read `window.__PAPERCUSP_WS__` (available pre-hydration via P-001), not
`?ws=`.
