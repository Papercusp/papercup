# Operator arc plan — 2026-05-12

Living record of the multi-plan work approved on 2026-05-12. Each plan is
independently mergeable. Update statuses as commits land.

## Plan 1 — Operator tool-access fix + framework consistency

| # | Item | Effort | Status |
|---|---|---|---|
| 1.1 | `mcp.discoveryDefaultServers: ['agentmcp']` per-spawn override in `libs/papercup-shared/src/agent/chat-stream.ts` | 1h | ✅ `c9c1aa8c` |
| 1.2 | Replace hardcoded built-in tool filter (Set of names) with `!startsWith('mcp__')` filter | 0.5h | ✅ `a74c04c1` |
| 1.3 | Document 6th plugin shape ("render-into-chat") in `docs/endpoint-system/function-as-truth.mdx` | 0.25h | ✅ `a74c04c1` |
| 1.4 | New `__tests__/integration/operator-tool-surface-consistency.test.ts` — catalog ⇄ MCP `tools/list` ⇄ `allowedTools` drift check | 2h | pending |

## Plan 4 — User accounts + per-user setting overrides

Multi-user same-workspace. Local-only auth. Optional password. Per-user settings
override workspace settings (not replace).

### Schema (`libs/papercusp/libs/db/sql/058-user-accounts.sql`)
- `harness_shared.users` (id, username, display_name, password_hash NULLABLE, created_at, last_login_at, is_active)
- `harness_shared.user_sessions` (token PK, user_id FK, expires_at, last_seen_at, user_agent, remote_addr)
- `harness_shared.user_preferences` (user_id PK, payload jsonb, updated_at)
- bcrypt via pgcrypto for password_hash. NULL = passwordless login.

### Settings that get user-override (NOT removed from workspace; added at user-scope, override at read-time)
- agentLanguage
- elevenlabsVoiceId
- wakeWordKeyword
- voiceMaxSpokenWords
- fullAgentIdleTimeoutMin
- fullAgentSessionMaxMin
- operatorHistoryTokenBudget
- operatorActiveOnStartup
- voicePrivacyMode
- speakSuggestions / speakReceivingFlips / speakCadenceStatus
- operatorBackstoryEnabled

Resolution order at read time: user pref (if set) → workspace pref → default.

### Routes (`apps/operator/app/api/auth/*`)
- POST /login { username, password? }
- POST /logout
- POST /signup { username, display_name, password? }
- POST /change-password { current, new }

### UI
- /login page (username dropdown OR text + optional password field)
- /signup page
- /settings/user page (display name, password mgmt, user-scoped pref overrides)
- User picker in chrome navbar (next to workspace picker)
- "Forget all my memory" button on /settings/user

### Welcome flow
- On successful login: write `pending_events` row `operator_welcome { user_id, display_name }`
- Client OperatorConversationProvider picks it up → `runGeneration('user_welcomed', {user})`
- Route handles `user_welcomed` trigger: "Welcome ${name}" + suggestions surfacing flow

### mem0 integration changes (deferred to Plan 3, scoped here)
- `userId = session.user.id` (was `'default'`)
- Pre-turn search filters: OR(workspace_id=ws, workspace_id=null)
- Workspace-shared memories stored with `metadata.shared: true`
- "Forget all my memory" route iterates mem0.getAll({userId: me}) → mem0.delete

### Open decisions resolved
- Fresh install: auto-create user "default" / display "User" / no password
- Cookie expiry: 30d default, user-configurable (1d / 7d / 30d / forever)
- user_id NOT in URL spawn params (cookie-only on chat surfaces)
- No OAuth providers
- Inform-don't-ask on memory writes ("I'll remember that")

| # | Item | Effort | Status |
|---|---|---|---|
| 4.1 | Schema + migration (058) + grants | 1h | ✅ `552f7b14` |
| 4.2 | Auth lib (`lib/auth/` — login, session, password) | 3h | ✅ `552f7b14` |
| 4.3 | `/api/auth/*` routes | 2h | ✅ `552f7b14` |
| 4.4 | Cookie middleware + session lookup | 1.5h | ✅ `552f7b14` (via getSessionUser) |
| 4.5 | user_preferences resolver — user > workspace > default | 2h | ✅ `552f7b14` |
| 4.6 | User picker in chrome | 1.5h | ✅ (this turn) |
| 4.7 | `/login`, `/signup`, `/settings/user` pages | 4h | ✅ (this turn, login + settings; signup folded into /login) |
| 4.8 | Welcome trigger + operator_welcome SSE event | 2h | pending |
| 4.9 | mem0 changes baked into Plan 3 | 2h | pending (Plan 3) |
| 4.10 | Tests + live verify | 2h | pending (needs servers) |

## Plan 2 — Semantic search

User chose **Plan C (BM25 + embeddings + RRF hybrid)** but ship in order: A first, then B+C.

### 2A — BM25 full-text first (single commit)
- pgvector NOT needed for this stage
- tsvector columns on harness_decisions, harness_escalations, harness_brainstorm
- GIN indices
- `search:fulltext` MCP tool with `query, scope[], harness_slug?, limit`
- Auto-update tsvectors via PG trigger on insert/update
- Backfill script for existing rows (1-time)

### 2B+C — Embeddings + RRF hybrid (after BM25 observation period)
- pgvector extension
- BGE-small via @xenova/transformers (worker-thread isolated, lazy-loaded)
- `text_embeddings` table (source_table, source_id, embedding vec(384))
- Background worker drains queue every 5s
- Backfill only decisions/escalations/brainstorm upfront (not operator_turns)
- `search:semantic` MCP tool (the public name; internally does BM25+embed+RRF)
- Battery-aware: pause background embeds when on battery <50%
- Reranker (E) DEFERRED until quality measurements demand it

| # | Item | Effort | Status |
|---|---|---|---|
| 2A.1 | tsvector columns + migration | 0.5h | pending |
| 2A.2 | `search:fulltext` tool + guidance | 1h | pending |
| 2A.3 | Backfill script | 0.5h | pending |
| 2B.1 | pgvector + text_embeddings schema | 1h | pending |
| 2B.2 | embeddings.ts wrapper (lazy, worker-thread) | 1.5h | pending |
| 2B.3 | Background embedding worker + battery awareness | 3h | pending |
| 2B.4 | Backfill script for existing prose | 1h | pending |
| 2B.5 | `search:semantic` tool with RRF fusion | 2h | pending |

## Plan 3 — mem0 integration (with per-user scoping from Plan 4)

Library mode (`mem0ai/oss`). pgvector backend. Anthropic Haiku for fact extraction.
Reuses Plan 2B's BGE-small embedder singleton.

### Key decisions
- **userId = session.user.id** (depends on Plan 4)
- expires_on metadata pattern (mem0 v2 removed first-class field)
- 5 kinds: identity / preference / project / correction / ephemeral
- Brain INFORMS user on writes ("I'll remember that"), never asks
- Auto-TTL worker daily for ephemeral
- Manual LLM-review cleanup invoked by user

### Tools (`apps/operator/lib/agent-tools/memory/*.ts`)
- memory:remember { content, kind, expires_at? }
- memory:search { query, filters? }
- memory:list { filters? }
- memory:forget { id }
- memory:update { id, content }

| # | Item | Effort | Status |
|---|---|---|---|
| 3.1 | Install mem0ai + config | 1h | pending |
| 3.2 | Schema grants for mem0 auto-tables | 0.5h | pending |
| 3.3 | 5 MCP tools + guidance | 4h | pending |
| 3.4 | Pre-turn auto-injection in operator-converse | 1.5h | pending |
| 3.5 | Post-turn extraction (fire-and-forget) | 1h | pending |
| 3.6 | Persona prompt: memory section (inform, don't ask) | 0.5h | pending |
| 3.7 | /settings/user/memory UI | 4h | pending |
| 3.8 | Auto-TTL cleanup worker + manual LLM review | 2h | pending |
| 3.9 | Tests + live verify | 3h | pending |

## Recommended ship order
1. **Plan 1.2 + 1.3** (small cleanup, ~45 min) — no servers needed
2. **Plan 1.4** (drift smoke test, 2h) — needs test runner, not full server
3. **Plan 4** (user accounts, 21h) — foundation for Plan 3's user-scoping
4. **Plan 2A** (BM25, 2h) — establish recall baseline
5. **Plan 2B+C** (after 1-2 weeks of BM25 observation, 8.5h) — only if BM25 misses
6. **Plan 3** (mem0 with user-scoping, 19h) — final layer

Total: ~50-58h across all phases.
