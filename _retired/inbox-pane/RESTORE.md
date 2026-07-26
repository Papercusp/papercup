# inbox-pane — retired 2026-07-26

**What:** the sidebar's human Inbox face (EI-13037, `?opcv=inbox`), retired per
owner directive 2026-07-26 (`hud-consolidation-2026-07-26` D-001): *"remove the
inbox pane from the left-hand toolbar and re-wire everything that opened the
inbox to open the conversation in the HUD tab."* The removal was GATED on
`hud-consolidation-2026-07-26` P-002 first proving that every ask the Inbox
covered — including attention items with a null/absent `ownerAgentId` — has a
home on the HUD board (`HudBoard.tsx`'s `.hud__unattributed` lane); it does, so
this retires a duplicate VIEW, not a pipeline.

**Moved here from `apps/operator/app/_components/inbox/`:**

| File | Was |
|---|---|
| `InboxPane.tsx` | the pane itself — decisions/escalations/messages list, filter/search, detail card, "Discuss in chat" seed action |
| `InboxPane.test.tsx` | its component tests |
| `inbox-pane.css` | its styles (`.inbox-pane` etc.) |

Import paths inside these files are **left exactly as they were** (relative to
their old location) per the repo's retiring convention — `_retired/` is
excluded from the workspace build/lint/test globs entirely, so nothing
resolves them and nothing needs to.

**Deliberately NOT retired (live, shared — do NOT move these here):**
`use-inbox-pending.ts` (`useInboxAttention`/`useInboxPendingCount`/
`usePlansNeedingYouCount`/`scopeInboxItems`/`isInboxActive`) — this is the
Inbox's DATA layer, and the HUD board (`HudView.tsx`) consumes it directly;
`chat-seed.ts` — shared with `OperatorChat.tsx`'s composer, not Inbox-specific
despite living in the same folder.

**Un-wired at retirement (restore = re-apply these):**
1. `apps/operator/app/_components/op-chat-faces.ts` — `BUILT_IN_CHAT_VIEWS`
   dropped `'inbox'`; add it back (order: `['chat', 'pot', 'inbox', 'plans']`).
2. `apps/operator/app/_components/OperatorChatSidebar.tsx` — re-add:
   the `InboxPane` lazy import; the `inboxOpen = view === 'inbox'` derived
   const; the Inbox toggle button (between Plans and Papercup — see git
   history around this commit for the exact JSX); the
   `) : inboxOpen ? (<InboxPane onDiscussInChat={...} />) : (` render branch.
3. `apps/operator/app/_components/chat/curator-card-drill-in.ts` /
   `OperatorChatSidebar.handleCardDrillIn` — P-004 (hud-consolidation-2026-07-26)
   rewired the drill-in destination from `setDrillNav({ opcv: 'inbox', opci,
   opcis })` to `router.push('/adv?tab=hud&hudsession=<ownerAgentId>')`.
   Restoring the Inbox pane does not require reverting P-004 (the resolution
   half — `resolveInboxDrillIn` — is unchanged and still correct either way),
   but the drill-in destination would need to be pointed back at the Inbox
   pane's `opcv`/`opci`/`opcis` params if the Inbox face returns.
4. `apps/operator/app/_components/__tests__/OperatorChatSidebar.component.test.tsx`
   — restore the `vi.mock('../inbox/InboxPane', ...)` stub and the Inbox-face
   test block this retirement rewrote into
   "Inbox face retirement + HUD conversation drill-in" (see this commit's diff
   for the pre-retirement test names/assertions).

**Last-active commit:** the tree state immediately before the git-sync commit
containing this file. (No git tag cut — git-sync owns commits on this tree.)
