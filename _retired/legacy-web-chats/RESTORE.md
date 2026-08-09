# legacy-web-chats — retired 2026-07-09, **PARTIALLY RESTORED since**

> ## ⚠ STATUS 2026-08-09: this retirement was PARTIALLY REVERSED. Read this box first.
>
> Everything below documents the state as of **2026-07-09** and is preserved as the
> restore runbook for what is *still* retired. It is NOT a description of the tree today.
> `OperatorChatSidebar` was revived under `operator-chat-sidebar-revival-2026-07-13`, and
> the P-010 backfill files came back with it. A RESTORE.md that outlives its own restore
> is a trap: the whole point of this file is to be trusted by someone deciding whether a
> surface is dead, and for a month it said "dead" about shipping code.
>
> | file | status today | where |
> |---|---|---|
> | `OracleDock.tsx` (+ test) | **STILL RETIRED** | here |
> | `TutorialButton.tsx` (+ test) | **STILL RETIRED** | here |
> | `OperatorChatSidebar.tsx` (+ `__tests__/`) | **LIVE** | `apps/operator/app/_components/` |
> | `OperatorChat.tsx` | **LIVE** | `apps/operator/app/_components/` |
> | `ChatConversation.tsx` | **LIVE** | `apps/operator/app/_components/chat/` |
> | `PendingCardsBar.tsx` | **LIVE** | `apps/operator/app/_components/chat/` |
> | `LocalCardHost.tsx` | **LIVE** | `apps/operator/app/_components/chat/` |
>
> So the "Moved here from `apps/operator/app/_components/`" table below is accurate only
> for the two OracleDock/TutorialButton rows; the rest have moved back.
>
> **The revived sidebar is live product surface, not a preserved artifact.** It is rendered
> by `ChromeShell.tsx` (L44 import, L352 mount) behind `FLAGS.OPERATOR_CHAT_SIDEBAR`, which
> derives **default-ON** (absent from `KNOWN_DARK_FLAGS`, so `production-defaults.test.ts`
> makes default-ON true by construction). Extend it, test it, fix it.
>
> **Point 9 below is SUPERSEDED — see the correction inline.** Verified 2026-08-09:
> `--op-chat-w` is live again, written at `OperatorChatSidebar.tsx:202` (removed at :227 on
> unmount), re-added to `RUNTIME_TOKENS` (`app/_lints/css-tokens.test.ts:65`), still
> documented in `design/gotchas.mdx`, and consumed by `DogfoodBootstrapBanner.tsx`
> (L80/83/87, guarded by the WI-4729 test).
>
> Points 1–8 and the P-010 notes are untouched and still describe real un-wiring — but
> re-check each against the tree before acting, since the restore re-applied an unrecorded
> subset of them.
>
> *(Corrected under EI-19485603307368652, which was filed because the matching CLAUDE.md
> retired-list entry had the same staleness. Note the asymmetry that let both survive a
> month: a doc that wrongly says "live" gets corrected the moment someone greps for the
> code, but a doc that wrongly says "retired" produces no error at all — it silently
> diverts work away, and nobody files a bug about work they decided not to do.)*

**What:** the legacy in-webview chat surfaces, retired per owner decision
(design-simplification-2026-07-09, D1): *"The Papercup chat in the zellij
window is the only one that should remain — OracleDock and OperatorChatSidebar
are legacy."* The surviving chat is the **terminal-native pui chat pane** in
the zellij dock (native-terminal-desktop D-011/P-016); these web surfaces were
already `FLAGS.TESTING`-gated (prod-dark) before removal.

**Moved here from `apps/operator/app/_components/`:**

| File | Was |
|---|---|
| `OracleDock.tsx` (+ `.test.tsx`) | floating multi-tab chat dock (oracle/support/chatwoot tabs, tutorial walkthrough listener) |
| `OperatorChatSidebar.tsx` (+ `__tests__/OperatorChatSidebar.component.test.tsx`, `__tests__/OperatorChatSidebar.test.ts`) | docked left "Papercup chat" web sidebar (`.op-chat-sidebar`) |
| `OperatorChat.tsx` (+ `.test.tsx`) | inner chat component; sole consumer was the sidebar |
| `TutorialButton.tsx` (+ `.test.tsx`) | header button whose only action fired OracleDock's `oracle:start-tutorial` event |

## Backfill — 2026-07-09, design-simplification P-010 (orphans this retirement left behind)

Retiring the parents above orphaned their shared children, but the first pass
listed them as *"deliberately NOT retired (live consumers remain)"*. **That was
wrong** — a per-file importer inventory found zero. (The check that produced the
false keep matched on file *content*; a `grep -v "/chat/"` filter silently drops
the very import lines `from './chat/X'` you are searching for. Scan by file
**path**, always.)

| File | Was | Why it is an orphan |
|---|---|---|
| `ChatConversation.tsx` (+ `.test.tsx`, `chat-recall.test.ts`) | the shared transcript view — its own docstring says *"used by both OracleDock and OperatorChat"* | rendered by nothing but its own test; **owned all 29 `.oracle-*` class usages**, and was the sole blocker for the P-010 CSS deletion |
| `PendingCardsBar.tsx` (+ `.test.tsx`) | the web chat's pending-cards strip | zero importers |
| `LocalCardHost.tsx` (+ `.test.tsx`) | the web `askUserLocal` card host | zero importers; the one grep hit was a *comment* in `packages/agent-mcp/src/delta-eval-harness.ts` |

`ChatConversation.tsx` also exported `lastUserMessageText` (the ↑-recall helper)
and `ChatIconComponent`; both were used only by it and its tests, so they retire
with it.

**Still live in `_components/chat/` — do NOT retire:** `AskChoiceCard.tsx`,
`InputCard.tsx`, `ReportBlockCard.tsx`. They are reached from
`app/admin/plans/{PlanOtherList,PlanItemPreview,QueueCardActions,attention-card}`
and `lib/chat-cards/AskChoiceCardEntry.tsx`, and **none of them uses an
`.oracle-*`/`.op-chat-*` class.** `ReportBlockCard` is reached transitively via
`AskChoiceCard`.

**Deliberately NOT retired (live consumers remain):**
`OperatorConversationProvider` (vite `__root.tsx`, login, AutoLoginWelcomeToast),
`_components/chat/chat-types.ts`, `lib/chat-cards/*`, `lib/use-state-snapshots.ts`,
`AudienceModeSelector` (PapercupVoiceBar), `SupportChatButton` (self-falls-back to
`/support` when no `[data-oracle-dock]` is present — verified in its own code),
`ChatwootWidget` (still mounted directly in ChromeShell's DeferredDocks).

**Un-wired at retirement (restore = re-apply these):**
1. `apps/operator/app/_components/ChromeShell.tsx` — re-add imports + the three
   mounts: `{testingFlag ? <TutorialButton/> : null}` (header),
   `{testingFlag && <OperatorChatSidebar/>}` (before DeferredDocks),
   `{testingEnabled ? <OracleDock/> : null}` (inside DeferredDocks, and re-add
   the `testingEnabled` flag read + the lazy `OracleDock` import).
2. `apps/operator/app/_components/ChromeShell.test.tsx` — restore the two
   vi.mocks + the op-chat/Tutorial assertions; drop the "never renders the
   retired legacy web chats" recurrence-guard test.
3. `apps/operator/app/_lints/design-primitives.test.ts` — re-add
   `'operator/app/_components/OracleDock.tsx'` to `AUDITED_DIRECT_CYAN_FILES`.
4. `git mv` the files back to `apps/operator/app/_components/` (+ `__tests__/`).

**Un-wired in the P-010 backfill (restore = re-apply these):**
5. `ChatMessage` / `ChatToolCall` were lifted out of `ChatConversation.tsx` into
   `apps/operator/app/_components/chat/chat-types.ts` (its only live edge was a
   type-only import in `OperatorConversationProvider.tsx`). Restoring
   ChatConversation means re-pointing that import, or having the component
   re-export from `chat-types.ts` — do **not** re-declare the types twice.
6. The three backfilled files import `./AskChoiceCard` / `./InputCard`, which
   stayed behind in `apps/operator/app/_components/chat/`. Their relative import
   paths are stale while they live here; fix them on restore.
7. `packages/agent-mcp/src/delta-eval-harness.ts` — a comment referencing
   `chat/LocalCardHost` as an example webview importer was dropped.

**Un-wired in the P-010 CSS deletion (restore = re-apply these):**
8. `apps/operator/app/globals.css` — all 399 `.oracle-*` / `.op-chat-*` /
   `body.has-op-chat` rules were deleted (−2,663 lines). The 4 orphaned
   `@keyframes op-chat-{empty-float,card-sheen,thinking-breathe,thinking-sheen}`
   went with them; the 2 that the surviving `AskChoiceCard` actually animates
   were **renamed, not deleted** — `op-chat-option-sheen` →
   `ask-choice-option-sheen`, `op-chat-card-pick` → `ask-choice-card-pick`.
   Restoring the components means restoring their CSS from this commit's parent.
9. ⚠ **SUPERSEDED 2026-08-09 — `--op-chat-w` IS LIVE AGAIN.** The paragraph below
   was true on 2026-07-09 and is false now; it is kept for the restore history.
   Measured today: the variable is written at `OperatorChatSidebar.tsx:202`
   (`setProperty`) and removed at :227 on unmount, it is back in the
   `RUNTIME_TOKENS` allowlist at `app/_lints/css-tokens.test.ts:65`, it is still
   documented in `design/gotchas.mdx`, and `DogfoodBootstrapBanner.tsx` consumes it
   at L80/83/87 (`left: var(--op-chat-w, 0px)`) under a WI-4729 regression test.
   So "gone, not merely unused" must NOT be relied on — the writer came back with
   the sidebar. Historical text follows:

   ~~`--op-chat-w` is **gone**, not merely unused.~~ `OperatorChatSidebar` was the
   only writer, so once it retired the variable could never resolve — the
   left-sidebar / dev-admin rails read it with a `0px` fallback, i.e. always 0.
   Removed from `left-sidebar.styles.ts`, `LeftSidebar.tsx` (its `leftOffset()`
   drag helper, always 0), `dev-admin-rail.styles.ts`, the `RUNTIME_TOKENS`
   allowlist in `css-tokens.test.ts`, and `design/gotchas.mdx`. Restoring the
   sidebar means re-adding the variable *and* its writer;
   `index-html-no-op-chat-reservation.test.ts` now guards both the pre-paint
   bootstrap and the rails' phantom offset.

**Known dead weight left in place:** stale prose mentions in comments/docs
(`el-min`, `Chromeless`, `process-polyfill`, `harness/dock/README.md`).

**Last-active commit:** the tree state immediately before the git-sync commit
containing this file. (No git tag cut — git-sync owns commits on this tree;
tag `legacy-web-chats-retired-2026-07-09` on the containing commit if desired.)
