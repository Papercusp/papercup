/**
 * EI-6643 regression — the doc-steward's platform tools are WIRED.
 *
 * A doc-steward spawn used to start with a near-empty MCP catalog: NONE of the
 * docs:* / harness_docs:* / work_items:* / coord:* tools its own persona instructs
 * it to call, and no ToolSearch to load them — so it fell back to a blind
 * scripts/mcp-call.mjs find-over-root. Root cause: `doc-steward` was a launch-blueprint
 * role that was never REGISTERED (absent from AGENT_ROLES / SU_ROLES / COORD_ROLES and
 * every harness_docs:* allowlist), so every role-gated `agentRoles` filter dropped it —
 * the same "registered late" class already fixed for queen/sentinel/content-fixer.
 *
 * These pin that the role is registered and that each tool the doc-steward persona
 * actually calls admits it. Once admitted, the role-scoped `tools/list` surfaces them
 * eagerly (the invoke path sets no `?tools=` seed → no deferral), so no ToolSearch is
 * needed. Mirrors the COORD_ROLES "consumer half" test in coordination/roles.test.ts.
 */
import { describe, test, expect } from 'vitest';
import { AGENT_ROLES, SU_ROLES } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../../agent-tools/coordination/roles';

const DOC_STEWARD = 'doc-steward';

describe('doc-steward tool wiring (EI-6643)', () => {
  test('doc-steward is a registered agent role (AGENT_ROLES)', () => {
    expect(AGENT_ROLES as readonly string[]).toContain(DOC_STEWARD);
  });

  test('doc-steward carries the documenter-equivalent SU + coord surface', () => {
    // SU_ROLES → docs:get/outline/search resolve; COORD_ROLES → coord:* + work_items:* resolve.
    expect(SU_ROLES as readonly string[]).toContain(DOC_STEWARD);
    expect(COORD_ROLES as readonly string[]).toContain(DOC_STEWARD);
  });

  test('every tool the doc-steward persona calls admits the doc-steward role', async () => {
    // Capability alone is not enough; the tool's agentRoles allowlist must include the
    // caller's role for a role-scoped (signed) doc-steward URL, else it fails
    // `role_not_allowed` with no other signal. Verify the whole persona toolset, not assume.
    const [{ default: docsGet }, { default: harnessDocsVerify }, { default: harnessDocsList }, { default: workItemsGet }, { default: coordEscalate }] =
      await Promise.all([
        import('../../agent-tools/docs/get.js'),
        import('../../agent-tools/harness_docs/verify.js'),
        import('../../agent-tools/harness_docs/list.js'),
        import('../../agent-tools/work_items/get.js'),
        import('../../agent-tools/coordination/tools/escalate.js'),
      ]);
    // The freshness-clear tool (harness_docs:verify) is the load-bearing one — without it
    // a fixed doc re-flags every sweep forever.
    for (const tool of [docsGet, harnessDocsVerify, harnessDocsList, workItemsGet, coordEscalate]) {
      expect(tool.agentRoles, `${tool.name} must admit ${DOC_STEWARD}`).toContain(DOC_STEWARD);
    }
  });
});
