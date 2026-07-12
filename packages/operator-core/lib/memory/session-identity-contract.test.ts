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
 *   - the turn-start hook (userpromptsubmit-memory.sh) POSTs owner=$PAPERCUSP_SID;
 *   - compact re-prime + the claim/create ports key on ownerId (resolved from
 *     the same client param).
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

  it('the turn-start hook sends the SAME identity (owner = $PAPERCUSP_SID)', () => {
    const hook = readFileSync(
      join(REPO, 'apps/operator/scripts/hooks/cc/userpromptsubmit-memory.sh'),
      'utf8',
    );
    // The hook gates on PAPERCUSP_SID and passes it as the endpoint's `owner`
    // (the dedup sessionId for port 'turn-start').
    expect(hook).toMatch(/PAPERCUSP_SID/);
    expect(hook).toMatch(/'owner':\s*sid/);
  });
});
