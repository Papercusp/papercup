# work-item-mail — retired 2026-07-26

**What:** the work-item MAIL surface — `messages:send` / `messages:dismiss` /
`messages:inbox` / `messages:outbox`, their `cross_harness:` analogs, and the
`executeAction` verbs behind them. Retired per owner directive 2026-07-26
(plan `surface-every-routine-and-unbreak-automation-panes-2026-07-25` P-008,
AskUserQuestion answer: *"Full retirement"*), tracked as **WI-6097**.

**Why — DISUSE, not brokenness.** The surface was fully wired and functional;
it simply lost to `coord:send`. Measured before removal:

| signal | value |
|---|---|
| `messages_consolidated` rows | 222 total; 197 landed on ONE day in May; 6 write-days ever |
| last row written | 2026-06-24 (ZERO rows in the trailing 30 days) |
| `messages:send` calls / 90d | 3 (2 agents) |
| `messages:outbox` / `messages:inbox` | 9 / 1 |
| `messages:dismiss`, `cross_harness:inbox`, `cross_harness:outbox` | **0 calls in 90d** |
| `coord:send` calls / 30d | **5,907** (529 agents) — ~400× the whole mail plane |

**⚠️ The plan's original premise was WRONG — do not trust it if you restore.**
P-008 as written said `messages_consolidated` "has no live writer in
operator-core". That was an artifact of grepping for the TABLE name. Every
`harness_<slug>.messages` is an auto-updatable **VIEW** over the one real table,
and writers address the *view*, so the table name never appears. This is
recorded as plan decision **D-004**. Generalizable trap: **check
`pg_class.relkind` before concluding "no writer".**

**Moved here:**

| File | Was |
|---|---|
| `send.ts` | `packages/operator-core/lib/agent-tools/messages/send.ts` (`messages:send`) |
| `dismiss.ts` | `packages/operator-core/lib/agent-tools/messages/dismiss.ts` (`messages:dismiss`) |
| `messages-tools.test.ts` | `packages/operator-core/lib/agent-tools/__tests__/messages-tools.test.ts` |
| `inbox.ts` | `packages/agent-mcp/src/tools/messages/inbox.ts` (`messages:inbox`) — retired plan P-001, `retire-work-item-mail-surface-2026-07-26` |
| `outbox.ts` | `packages/agent-mcp/src/tools/messages/outbox.ts` (`messages:outbox`) — same lane |
| `inbox.test.ts` | `packages/agent-mcp/src/tools/messages/inbox.test.ts` |
| `outbox.test.ts` | `packages/agent-mcp/src/tools/messages/outbox.test.ts` |

Import paths inside these files are **left exactly as they were** per the repo's
retiring convention — `_retired/` is excluded from the workspace
build/lint/test globs, so nothing resolves them.

**DATA IS PRESERVED — this was CODE removal only.** All 222 rows remain in
`harness_shared.messages_consolidated`, and the existing per-harness
`messages` views were deliberately **not dropped**. Restoring is a code-only
operation. Note the federation hazard that made this non-negotiable:
`coord_event_log`-style retention DELETEs on harness-scoped rows FEDERATE to
peers, so deleting rows here could propagate. Keep it code-only.

**Un-wired at retirement (restore = re-apply these):**

0. `packages/agent-mcp/src/bootstrap.ts` — re-add
   `import './tools/messages/inbox';` and `import './tools/messages/outbox';`
   (move `inbox.ts`/`outbox.ts`/their `.test.ts` back to
   `packages/agent-mcp/src/tools/messages/` first). `role-config.ts` did not
   name either tool at retirement time — check it again for drift before
   assuming no re-wiring is needed there.
1. `packages/operator-core/lib/agent-tools/index.ts` — re-add
   `import './messages/send';` and `import './messages/dismiss';` after
   `./tasks/create` (move the two tool files back first).
2. `packages/operator-core/lib/execute-action.ts` — the mail verbs were removed
   end-to-end. Restore: the `SendMessageAction`, `MarkMessageStatusAction` and
   `MarkCampaignPublishedAction` interfaces + their `ExecuteAction` union
   members; `doSendMessage`, `doMarkMessageStatus`, `doMarkCampaignPublished`;
   the `send_message`/`mark_message_status`/`mark_campaign_published` cases in
   the validation switch and in `dispatchAction`; the `send_message` arm of
   `extractTargetSlug`; the `send_message` `from`-spoof check in
   `validateIdentityFields`; the `send_message` branch of `verifyEffectExists`;
   and the rate limiter (`SEND_MESSAGE_RATE_LIMIT`, `RATE_WINDOW_MS`,
   `checkSendMessageRate`).
3. `packages/operator-core/lib/execute-action.ts` — the schema-existence cache
   (`schemaExistsCache`, `SCHEMA_EXISTS_TTL_MS`, `harnessSchemaExists`,
   `__resetSchemaExistsCacheForTest`) and the `PLACEHOLDER_REASON` regex were
   removed with it. They served ONLY `doSendMessage` (the WI-3800 pgbouncer
   optimisation for its recipient pre-check, and its `reason` audit grade).
4. `packages/operator-core/lib/execute-action.ts` — `doSpinupProject` lost its
   Kickoff/Priority/Budget message fan-out to each department (it was the last
   writer to `harness_<slug>.messages` outside the mail verbs). The project
   INSERT itself is untouched.
5. `packages/operator-core/lib/execute-action.test.ts` — the
   `doSendMessage — recipient harness existence (WI-385)` suite, the two
   `send_message`-spoof cases, and the `getOrgPg`/`sql` mock that existed only
   to serve them were removed. See git history at this commit for the originals.
6. **P-004 (sync/data-layer readers)** —
   `packages/operator-core/lib/sync-resolver/index.ts`: restore the
   `'conversations.messageList'` and `'conversations.messageDetail'` REGISTRY
   entries (both queried `harness_shared.messages_consolidated`; see git
   history at this commit for the exact SQL — `messageList` was a
   `LIMIT`+`count(*)` pair with a 280-char body truncation, `messageDetail`
   was a scoped by-id lookup).
   `packages/operator-core/lib/sync-resolver/table-to-query-names.ts`:
   restore the `'harness_shared.messages_consolidated': ['conversations.messageList',
   { name: 'conversations.messageDetail', scope: idScope }]` entry.
   `packages/agent-mcp/src/tools/search/query.ts`: restore `'messages'` to
   the `KINDS` tuple, the `MessageSearchRow`/`MessageFallbackRow` types, and
   the `if (wantKind('messages'))` block (FTS over an inline
   `to_tsvector(subject || body)` + ILIKE fallback, both against
   `harness_shared.messages_consolidated`).
   Also restore the matching test fixtures/assertions in
   `table-to-query-names.test.ts`, `sync-resolver/index.test.ts`,
   `sync-read-audit.ts` (`'conversations.messageDetail': null` allowlist
   entry), and `packages/agent-mcp/src/tools/search/query.test.ts` — see git
   history at this commit for the originals.
   ⚠️ **Not un-wired by P-004** (a separate gap found while doing this lane,
   not yet fixed as of this note): `apps/operator-vite/src/components/left-sidebar/ConversationsTab.tsx`
   and the shared `apps/operator-core/lib/../components/conversations/unified-conversations.ts`
   ALSO read `conversations.messageList`/`messageDetail` (the left-sidebar
   rail's "Mail" source) but were never listed in this plan's P-005 item text
   (which only names `AdvConversationsTab.tsx`). Check whether P-005 covered
   them before assuming a clean restore/removal state.

**Deliberately NOT retired (live, shared — do NOT move these here):**
`packages/operator-core/lib/cross-harness-data.ts` — only `readInbox`/
`readOutbox` are mail. `slugToSchema`, `readSupervisorNotes` and
`readRecentActivity` read DIFFERENT tables (`supervisor_notes`, `audit_log`)
and remain live.

**A note on `supervisor_notes`:** `doSendMessage` was the ONLY writer to
`harness_<slug>.supervisor_notes` (it appended there when `kind === 'Directive'`).
That looked load-bearing, but the "Directive → supervisor_notes → orchestrator
wakes → role runs" consumers exist ONLY under `libs/papercusp/_retired/`
(the retired orchestrator run-loop and retired apps-web). The remaining live
readers are the `cross_harness:supervisor_notes` READ tool and the scaffold.
So the table now has no writer BY DESIGN — that is not a bug to "fix" by
reintroducing a message verb. Its 43 rows (last written 2026-06-24) are preserved.

**Last-active commit:** the tree state immediately before the git-sync commit
containing this file. (No git tag cut — git-sync owns commits on this tree.)
