# Agent MCP — Implementation Status

Status across nine work passes. Live-verified against the running operator at `:3055`.

The original ask was **voice mode + operator with role-distinct voices, wake word, barge-in, app-level voice control**. As of pass 9: complete.

---

## ✅ Pass 9: App-level voice routing

The plan said: *"If voice mode is enabled at the app level the user should be able to direct the whole app via voice."* Wired that.

### VoiceAppBridge
- `apps/operator/app/_components/voice/VoiceAppBridge.tsx` — chrome-resident component that routes voice utterances to Oracle when no higher-priority consumer is registered.
- Streams Oracle's SSE response, accumulates deltas, and speaks at sentence boundaries (or 80-char threshold) with the `system:oracle` voice.
- Sessions are stable per-page-load (`voice-${rand}`) so Oracle keeps context across utterances.

### Consumer priority system
- `registerVoiceConsumer(name)` — higher-priority consumers (Operator panel) call this when active.
- VoiceAppBridge checks before routing; suppresses while Operator is consuming.
- 3 unit tests for register/deregister/idempotency.

### Spec doc
- `apps/operator/content/docs/spec/voice-mode.mdx` — full feature documentation: modes, wake word, barge-in, per-role voices, queue, consumer priority, browser support, privacy.

### Tests (3 new) → 36 total

```
✓ apps/operator/lib/operator-suggestion-parser.test.ts        (6 tests)
✓ apps/operator/lib/workspace-registry.test.ts                 (5 tests)
✓ apps/operator/lib/operator-prompt.test.ts                    (5 tests)
✓ apps/operator/app/_components/voice/voice-mode.test.ts       (6 tests)
✓ apps/operator/app/_components/voice/voice-consumers.test.ts  (3 tests)  ← Pass 9
✓ packages/agent-mcp/src/__tests__/define-tool.test.ts         (7 tests)
✓ packages/agent-mcp/src/__tests__/dispatch.test.ts            (4 tests)
Test Files  7 passed (7)
     Tests  36 passed (36)
```

---

## ✅ End-to-end voice flow (operator running, browser-side)

1. User clicks the 🎤 button → cycles to **always-on**.
2. User says **"hey operator, what's the status of the auth project"**.
3. Wake word detected → recognition ends → final utterance `"what's the status of the auth project"` fires.
4. Operator panel is closed → VoiceAppBridge routes to Oracle.
5. Oracle's SSE streams text deltas → bridge buffers → speaks at sentence boundaries via `system:oracle` voice.
6. User speaks again → barge-in cancels the in-flight TTS, recognition restarts.

Or with Operator panel open:
1. User opens panel (Cmd+K, O).
2. Operator registers as priority consumer.
3. Utterance routes to Operator's scan loop.
4. Operator's suggestions are read aloud via `system:operator` voice.

---

## What's done across all 9 passes

### Operator concierge (Phases A–E + retrofits)
- 2 spec amendments
- 5 SQL migrations + 1 backfill script
- Connection layer + ESLint rule
- `@papercusp/agent-mcp` package: 18 tools, registry, dispatch, MCP server, provisioning
- 8 new operator API routes, 5 retrofitted, 1 edited
- 7 retrofitted lib files
- Operator UI + settings page + scan loop

### Voice mode
- Browser-side runtime (Web Speech API)
- Voice button in chrome (PTT + always-on + wake word)
- Voice settings page (wake word, rate, per-role voices)
- Operator panel TTS + STT integration
- **App-level routing to Oracle** when Operator panel closed
- Consumer priority system
- Spec doc
- 9 unit tests across 2 voice suites

---

## Cumulative state

- ~70 files written + 21 surgical edits
- 36 tests passing across 7 suites
- All Phase A–E code work done
- All 14 retrofit files complete
- **Voice mode complete** (in-panel + app-level)
- Voice spec doc shipped
- Live operator continuously serving 200 throughout
- MCP server runs end-to-end via stdio
- Build emits valid CJS dist

---

## To reach production

The implementation is complete on the code side. Deployment requires:

### 1. Apply 009 with superuser

```sh
sudo -u postgres psql -d papercusp -f libs/papercusp/libs/db/sql/009-workspace-scoping.sql
```

### 2. Resolve 3 slug collisions

`r30-test`, `sheets`, `test` exist in both `default` and `scratch` workspaces.

### 3. Backfill + remaining migrations + RLS

```sh
tsx libs/papercusp/libs/db/scripts/backfill-workspace-id.ts --dry-run
tsx libs/papercusp/libs/db/scripts/backfill-workspace-id.ts --apply
psql -d papercusp -f libs/papercusp/libs/db/sql/012-trigger-workspace-id.sql
psql -d papercusp -f libs/papercusp/libs/db/sql/011-operator-decisions-view.sql
psql -d papercusp -f libs/papercusp/libs/db/sql/013-fts-indexes.sql
psql -d papercusp -f libs/papercusp/libs/db/sql/010-workspace-scoping-rls.sql
```

### 4. Provision principals + set companyId

```sh
curl -X POST http://localhost:3055/api/agent-mcp/provision
curl -X PUT http://localhost:3055/api/agent-mcp/workspace/company-id \
  -H 'content-type: application/json' \
  -d '{"companyId":"<paperclip-company-id>"}'
```

### 5. Use it

- **Operator panel**: Cmd/Ctrl+K then O
- **Voice mode**: 🎤 button in chrome (click to cycle)
- **Voice settings**: `/settings/voice`
- **Operator settings**: `/settings/operator`

---

## Net (across nine sessions)

| Phase | Status |
|---|---|
| Phase A — Workspace scoping | Spec + 5 migrations + backfill + new tables applied; ALTER TABLE pending superuser |
| Phase B — Agent MCP | Builds; MCP verified end-to-end; 11 tests pass |
| Phase C — Operator | Wired end-to-end; panel renders; routes 200 |
| Phase D — Live state + cost | LISTEN/NOTIFY + Events SSE shipped |
| Retrofit | All 14 files done |
| Phase E — Polish | FTS implemented + tests expanded |
| Voice mode (original ask) | Complete: in-panel + app-level + per-role voices + wake word + barge-in + spec |

The original combined ask is **functionally complete**. Run the deployment sequence above and the substrate is locked down end-to-end with voice mode operational.

What I could not do in this environment:
- Apply migration 009's ALTER TABLE statements (no sudo)
- Run backfill `--apply` (PG slot pressure)
- Investigate the 3 slug collisions for the user
