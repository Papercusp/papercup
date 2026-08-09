/**
 * orient-recall-quality-2026-07-12 P-004(b) — the cross-port SESSION-IDENTITY
 * contract pins (audit finding 4 of the memory-delivery-unification review).
 *
 * The warm-session dedup ledger (memory_session_surfaced) is port-agnostic ONLY
 * because every injection moment happens to key on the SAME session identity:
 *
 *   - MCP initialize stamps under ctx.uiClientId — which _mcp-handler derives
 *     from the `?client=` URL param, which claude-integration.ts templates as
 *     `client=${PAPERCUSP_SID:-<agentId>}`;
 *   - the turn-start hook POSTs owner=$PAPERCUSP_SID;
 *   - compact re-prime + the claim/create ports key on ownerId (resolved from
 *     the same client param).
 *
 * ⚠ WHERE THE HOOK END LIVES MOVED (codex-context-injection-parity-2026-08-09
 * P-002 / D-001). userpromptsubmit-memory.sh used to build the POST body inline
 * (~60 lines of python-in-shell, where this test's original `'owner': sid` pin
 * matched). It is now a THIN EXEC SHIM delegating to ONE shared dispatcher,
 * apps/operator/scripts/hooks/inject/, with a per-client adapter — so the
 * identity is derived in core.mjs, not in the bash file.
 *
 * The CONTRACT is unchanged and so is this test's job; only the address moved.
 * Pinning the shim's text alone would be worse than useless now: the shim still
 * mentions PAPERCUSP_SID in a COMMENT, so a bare /PAPERCUSP_SID/ match passes
 * against prose while the real derivation could drift away unnoticed. So we pin
 * BOTH links of the chain — the shim still reaches the dispatcher, AND the
 * dispatcher still derives owner from PAPERCUSP_SID and sends it as `owner`.
 *
 * NOTHING type-checks this equivalence — it's a string convention across a TS
 * template, a bash hook, and a resolver. If any end drifts (a renamed env var, a
 * different URL param), cross-port dedup silently degrades to re-injection with
 * zero errors. These pins turn that silent drift into a red test naming the
 * contract. They are deliberately source-text pins (the ends live in different
 * languages); the runtime half is session-epoch-cross-port.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../../../..');

describe('cross-port session-identity contract (P-004b)', () => {
  it('claude-integration templates the MCP client identity from PAPERCUSP_SID', () => {
    const src = readFileSync(
      join(__dirname, '../desktop-install/claude-integration.ts'),
      'utf8',
    );
    // The `?client=` param IS the session identity every port keys on
    // (_mcp-handler: suIdentity = headerClient || clientParam || mcpSessionId).
    expect(src).toContain('&client=\\${PAPERCUSP_SID:-');
  });

  it('the turn-start hook still REACHES the shared injection dispatcher', () => {
    const hook = readFileSync(
      join(REPO, 'apps/operator/scripts/hooks/cc/userpromptsubmit-memory.sh'),
      'utf8',
    );
    // Link 1 of the chain. Deliberately NOT a bare /PAPERCUSP_SID/ match: that
    // string survives in this file's comment banner, so it would pass on prose.
    // What must hold is that the shim still dispatches, as THIS client.
    expect(hook).toMatch(/inject\/index\.mjs/);
    expect(hook).toMatch(/--client=claude/);
  });

  it('the dispatcher sends the SAME identity (owner = $PAPERCUSP_SID)', () => {
    const core = readFileSync(
      join(REPO, 'apps/operator/scripts/hooks/inject/core.mjs'),
      'utf8',
    );
    // Link 2. The session id IS the gate (no PAPERCUSP_SID ⇒ not a psu session,
    // so no injection at all), and it is what goes out as the endpoint's
    // `owner` — the dedup sessionId every other port keys on.
    expect(core).toMatch(/env\.PAPERCUSP_SID/);
    expect(core).toMatch(/const owner = sessionId\(env\)/);
    // ...and is actually PUT on the request, not merely computed.
    expect(core).toMatch(/^\s*owner,\s*$/m);
  });
});
