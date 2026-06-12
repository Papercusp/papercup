---
name: wi-126-slash-dispatch
description: WI-126 implementation status — slash:dispatch MCP tool for agent-to-agent slash command delivery
metadata:
  type: project
---

## WI-126: slash:dispatch MCP tool

**Status:** Implementation found at HEAD, tested and passing. Tool is complete and wired into the agent-tools registry.

### Implementation location
- **Main tool:** `packages/operator-core/lib/agent-tools/slash/dispatch.ts`
- **Tests:** `packages/operator-core/lib/agent-tools/slash/dispatch.test.ts` (all passing, 5 test cases)
- **Registry import:** `packages/operator-core/lib/agent-tools/index.ts` line 268

### Key components verified
1. **Resolution** (renderSlashPrompt): Imported from @papercusp/agent-mcp, renders instruction at line 89
2. **Delivery** (inbox-wake path): 
   - sendMessage() at line 106 persists message with wake intent
   - wakeRecipients() at line 114 re-invokes sleeping targets
   - Per EI-279 federation intent: `extra: { wake: true }` passed
3. **Audit telemetry**: audit_log INSERT at line 125 with action 'slash.dispatch' (follows P-006 decision: audit_log sink, fire-and-forget)
4. **Manual-mode gate**: Respects target wake mode — stages for manual-mode, wakes auto-mode (lines 149-153)
5. **Error handling**: Validates tool existence, MCP exposure, slash opt-out before sending (lines 76-84)

### Test coverage
- ✓ Basic dispatch + delivery (woken target)
- ✓ Manual-mode staging (dispatched command awaits owner release)
- ✓ Injected delivery (no live wake-watch)
- ✓ Unknown tool rejection
- ✓ Slash-opted-out tool rejection
- ✓ Audit row fire-and-forget

### Integration notes
- No new transport (per D-001)
- Receiver-side gating applies via target's MCP session
- Self-application: agent can call directly (no dispatcher needed)
- Telemetry: consistent with P-006 (audit_log, action=slash.dispatch vs. slash.prompt_get for prompts/get)

**Next:** Verify against P-006 status with su-2bb6a (Queen directive); consider final testing if live session check needed.
