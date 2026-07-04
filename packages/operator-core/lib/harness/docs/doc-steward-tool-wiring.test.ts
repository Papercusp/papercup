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
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../../agent-tools/coordination/roles';

const DOC_STEWARD = 'doc-steward';

describe('doc-steward tool wiring (EI-6643)', () => {
  test('doc-steward is a registered agent role (AGENT_ROLES)', () => {
    // Unregistered → every role-gated allowlist silently dropped it (the EI-6643 root cause).
    expect(AGENT_ROLES as readonly string[]).toContain(DOC_STEWARD);
  });

  test('doc-steward is a coord role (work_items:get + coord:escalate resolve for its URL)', () => {
    expect(COORD_ROLES as readonly string[]).toContain(DOC_STEWARD);
  });

  test('every platform tool the doc-steward persona calls admits the doc-steward role', async () => {
    // Registration alone is not enough; each tool's agentRoles allowlist must include the
    // caller's role for a role-scoped (signed) doc-steward URL, else it fails
    // `role_not_allowed` with no other signal. Verify the whole persona toolset, don't assume.
    // (docs:get is deliberately NOT here — the persona reads the file / harness_docs:list, and
    // granting docs:* via SU_ROLES would strip the native file/git tools the steward needs.)
    const [
      { default: harnessDocsVerify },
      { default: harnessDocsList },
      { default: harnessDocsRecord },
      { default: harnessDocsIngest },
      { default: workItemsGet },
      { default: coordEscalate },
    ] = await Promise.all([
      import('../../agent-tools/harness_docs/verify.js'),
      import('../../agent-tools/harness_docs/list.js'),
      import('../../agent-tools/harness_docs/record.js'),
      import('../../agent-tools/harness_docs/ingest.js'),
      import('../../agent-tools/work_items/get.js'),
      import('../../agent-tools/coordination/tools/escalate.js'),
    ]);
    // harness_docs:verify is the load-bearing one — without it a fixed doc re-flags every
    // sweep forever (the doc-steward's whole reason to exist). harness_docs:record is the
    // OTHER load-bearing one (EI-7272): the steward calls it immediately after re-syncing a
    // drifted doc to stamp its new provenance/baseline — without it, a "fixed" doc has no
    // recorded baseline and re-flags as drifted on the very next sweep, same failure shape
    // as a missing verify grant. harness_docs:ingest covers the one-time-backfill edge case
    // a full sweep can still hit (an un-anchored doc discovered mid-run).
    for (const tool of [harnessDocsVerify, harnessDocsList, harnessDocsRecord, harnessDocsIngest, workItemsGet, coordEscalate]) {
      expect(tool.agentRoles, `${tool.name} must admit ${DOC_STEWARD}`).toContain(DOC_STEWARD);
    }
  });
});
