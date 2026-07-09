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

**Deliberately NOT retired (live consumers remain):**
`OperatorConversationProvider` (vite `__root.tsx`, login, AutoLoginWelcomeToast),
`_components/chat/ChatConversation.tsx`, `chat/LocalCardHost.tsx`,
`lib/chat-cards/*`, `lib/use-state-snapshots.ts`, `AudienceModeSelector`
(SentinelVoiceBar), `SupportChatButton` (self-falls-back to `/support` when no
`[data-oracle-dock]` is present — verified in its own code), `ChatwootWidget`
(still mounted directly in ChromeShell's DeferredDocks).

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

**Known dead weight left in place (cleanup tracked in
design-simplification-2026-07-09 P-010):** `.oracle-*` (~318 selectors) and
`.op-chat-*` rule blocks in `apps/operator/app/globals.css`; the `--op-chat-w`
runtime-token allowlist entry in `css-tokens.test.ts` (left-sidebar/dev-admin
rail still read it with a `0px` fallback); stale prose mentions in comments/
docs (`el-min`, `Chromeless`, `process-polyfill`, `harness/dock/README.md`).

**Last-active commit:** the tree state immediately before the git-sync commit
containing this file. (No git tag cut — git-sync owns commits on this tree;
tag `legacy-web-chats-retired-2026-07-09` on the containing commit if desired.)
