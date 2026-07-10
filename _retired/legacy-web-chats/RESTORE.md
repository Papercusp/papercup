# legacy-web-chats — retired 2026-07-09

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

**Known dead weight left in place:** the `--op-chat-w` runtime-token allowlist
entry in `css-tokens.test.ts` (left-sidebar/dev-admin rail still read it with a
`0px` fallback — it is a live CSS **variable**, distinct from the dead
`.op-chat-*` classes); stale prose mentions in comments/docs (`el-min`,
`Chromeless`, `process-polyfill`, `harness/dock/README.md`).

**Last-active commit:** the tree state immediately before the git-sync commit
containing this file. (No git tag cut — git-sync owns commits on this tree;
tag `legacy-web-chats-retired-2026-07-09` on the containing commit if desired.)
