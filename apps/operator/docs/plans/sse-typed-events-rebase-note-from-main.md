# sse-typed-events rebase notes (from main)

This note tracks main-side changes the `sse-typed-events` branch will
need to reconcile when rebasing. Owners on the branch are listed where
known. Last updated: 2026-05-12 evening.

## 1. JSON-schema flattener — `02dde625`

**Where:** `packages/agent-mcp/src/define-tool.ts`, both `toJSONSchema`
call sites.

**Why:** OpenAI strict-mode tool calling rejects `anyOf`/`oneOf` at the
root of a tool's `inputSchema`. The flattener wraps these into a proper
`{ type: "object", properties: {...} }` shape by merging the variants
of `z.discriminatedUnion` / `z.union` into a flat properties bag with
all branches as optional.

**Resolution:** On rebase, the `sse-typed-events` definitions for
`inputSchema` should be renamed to `rawSchema` and the final assignment
should pipe through `flattenForOpenAi(rawSchema)`. The 12 flattener
tests (`__tests__/define-tool.test.ts`) pin the contract; if they pass,
the merge is correct.

## 2. Cross-route mem0 injection — `6e10c571`

**Where:** main has `buildMemoryContextBlock()` in
`apps/operator/lib/memory/injection.ts` (with 14 unit tests in
`injection.test.ts`). It is now called from:

- `app/api/agent-mcp/operator-chat/route.ts` (session-creation turn,
  workspace-only scope — that route is bearer-authed with no cookie user)
- `app/api/agent-mcp/delegate-chat/route.ts` (same shape)

**Branch-side state:** `sse-typed-events` extracted operator-converse's
inline injection into `lib/agent-tools/operator/converse-prompt.ts`.
That code can be replaced with a single call to the helper:

```ts
import { buildMemoryContextBlock, lastUserContext } from '@/lib/memory/injection';

// inside composeOperatorConversePrompt, replace the 30-line memory block with:
const memBlock = await buildMemoryContextBlock({
  userId: sessionUser?.id ?? null,
  workspaceId,
  queryContext: lastUserContext(messages, 3),
});
if (memBlock) sections.push(memBlock);
```

**Missing routes that should adopt the helper after rebase:** the
branch has `composeArchitectPrompt` and `composeBrainstormPrompt` in
`lib/agent-tools/architect/prompts.ts`. Neither currently injects
mem0 memories. Both should call:

```ts
const memBlock = await buildMemoryContextBlock({
  userId: null,                  // architect/brainstorm have no session user
  workspaceId: activeWorkspaceId(),
  queryContext: message,
  heading: 'Architect memory (relevant entries)',   // or Brainstorm
});
if (memBlock) sections.push(memBlock);  // or splice into the systemPrompt template
```

This unlocks "the architect remembers the workspace's prior design
decisions" with zero new infrastructure.

## 3. Memory feedback table — `6e10c571` + submodule `c52b430`

Migration 062 adds `harness_shared.memory_feedback`. `/api/user/memory`
PATCH/DELETE now records `edit` / `delete` / `forget_all` events.
`/api/user/memory/feedback` exposes per-user stats; the
`/settings/user/memory` page surfaces a "Lifetime feedback: N edits, M
deletes" line.

**No branch impact** — these are user-route changes that don't touch
the chat-route refactor.

## 4. Plan 2B+C (semantic search + RRF) — `63182bc4` + `e16351b7`

New tool `search:semantic` plus pure RRF combiner in
`lib/agent-tools/search/rrf.ts`. The tool registry change in
`lib/agent-tools/index.ts` is additive. Drift test (`__tests__/integration/tools-md-sync.mjs`)
shows 22/0 — the new tool's catalog entry is in place.

**No branch impact** unless `sse-typed-events` removed any agent-tool
registrations.

## 5. Re-embed worker — `fcc080c2`

`/api/user/memory/reembed` plus mode-switch buttons on
`/settings/user/memory`. Worker lives in
`apps/operator/lib/memory/reembed.ts`. No branch impact.

## 6. Embedded-pg pgvector bundling — `465bbd6` (papercusp-desktop)

Desktop build scripts now copy pgvector into the embedded-postgres
tree on Linux + macOS. Migration 060 wraps `CREATE EXTENSION vector`
in DO/EXCEPTION so the boot path tolerates Windows (in-memory fallback).

**No branch impact.**
