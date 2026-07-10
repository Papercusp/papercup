/**
 * bee-tool-boundary.test.ts — the Phase-2 boundary for bee-capability-expansion-2026-06-08
 * (P-004). Pins, EMPIRICALLY against the real tool definitions + the real bee cap set,
 * exactly which tools a bee-role-scoped (signed) MCP caller CAN and CANNOT reach.
 *
 * Why a dedicated test: a bee's reach is the conjunction of TWO independent gates the
 * dispatch stack runs (libs/generic/tooldef/dispatch-stack.ts):
 *   1. role-allowlist — a tool that declares `agentRoles` is callable only by a role in
 *      that list (dispatch-stack.ts: `tool.agentRoles.includes(ctx.role)`), regardless of caps.
 *   2. capability — the caller's synthesized principal must hold `tool.capability`.
 * A bee is admitted iff BOTH pass (it carries no gateBypass — only superuser/power-user do).
 * The plan's Phase-1 cap grant (BLUEPRINT_ROLE_CAPS['cup']) is necessary but INERT until the
 * allowlist co-edit adds `cup` to each tool's agentRoles — so this test reproduces the exact
 * two-gate predicate over the REAL tool exports and the REAL loaded caps, catching either gate
 * silently regressing.
 *
 * This is the consumer-side counterpart to role-principal-caps.test.ts (which pins the cap SET)
 * and roles.test.ts (which pins COORD_ROLES membership + the 3 idea/issue allowlists).
 */
import { describe, test, expect } from 'vitest';
import type { Sql } from 'postgres';
import { loadRoleCapabilities } from './role-principal-caps.js';

/** A fake `tx` tagged-template returning no system_principals row, so a bee gets exactly
 *  its workspace-agnostic BLUEPRINT_ROLE_CAPS baseline (mirrors role-principal-caps.test.ts). */
const fakeTx = (): Sql => (() => Promise.resolve([])) as unknown as Sql;

/** The exact two-gate predicate the dispatch stack applies to a role-scoped (non-bypass) caller. */
function beeReach(
  tool: { agentRoles?: readonly string[]; capability?: string },
  beeCaps: Set<string>,
): { roleOk: boolean; capOk: boolean; callable: boolean } {
  const roleOk = !tool.agentRoles || tool.agentRoles.includes('cup');
  const capOk = !tool.capability || beeCaps.has(tool.capability);
  return { roleOk, capOk, callable: roleOk && capOk };
}

// Minimal shape we read off each real defineTool default export.
type ToolDef = { name: string; capability?: string; agentRoles?: readonly string[] };
const importTool = async (p: string): Promise<ToolDef> =>
  ((await import(p)) as { default: ToolDef }).default;

// CAN: the engineering surface the expansion unlocked for the worker-bee. Each must pass
// BOTH gates. The path + the cap the bee relies on are listed for a legible failure.
const CAN: Array<{ path: string; via: string }> = [
  { path: '../../../agent-tools/dev/service_health.js', via: 'intel:read' },
  { path: '../../../agent-tools/dev/build_status.js', via: 'intel:read' },
  { path: '../../../agent-tools/locks/acquire.js', via: 'locks:write' },
  { path: '../../../agent-tools/locks/queue.js', via: 'locks:read' },
  { path: '../../../agent-tools/db/check_drift.js', via: 'locks:read' },
  { path: '../../../agent-tools/db/next_migration.js', via: 'locks:write' },
  { path: '../../../agent-tools/harness_docs/record.js', via: 'docs:write' },
  // issues:* retired onto work_items:* (coordination-unification-2026-06-23 P-015) — the
  // bee's engineering surface is now the unified work-item tools:
  { path: '../../../agent-tools/work_items/list.js', via: 'work_items:read (unified work-item surface)' },
  { path: '../../../agent-tools/work_items/get.js', via: 'work_items:read (unified work-item surface)' },
  { path: '../../../agent-tools/work_items/create.js', via: 'work_items:write + COORD_ROLES' },
  { path: '../../../agent-tools/improvements/capture.js', via: 'coord:write + COORD_ROLES' },
  { path: '../../../agent-tools/plans/edit.js', via: 'plans:write (D-005 parity)' },
  { path: '../../../agent-tools/plans/set-status.js', via: 'plans:write (D-005 parity)' },
];

// CANNOT: the Queen-only surface (D-002). Split by WHICH gate enforces the boundary, so a
// future change that flips the enforcement layer (e.g. grants the cap) is caught here.
//  - capabilityDenied: the bee never holds the cap → blocked regardless of any allowlist.
//  - roleDenied: the bee HOLDS the cap (work_items/harness/coord) but is filtered out of the
//    allowlist — the placement/optimization carve-out (cup:spawn, gym:*).
const CANNOT_CAP: Array<{ path: string }> = [
  { path: '../../../agent-tools/operator/converse.js' }, // operator:converse
  { path: '../../../agent-tools/operator/nudge.js' }, // operator:write
  { path: '../../../agent-tools/pot/declare_wake.js' }, // routines:write
  { path: '../../../agent-tools/processes/kill.js' }, // processes:kill
  { path: '../../../agent-tools/autoloop/control.js' }, // autoloop:write
  { path: '../../../agent-tools/curation/feed.js' }, // curation:read
];
const CANNOT_ROLE: Array<{ path: string }> = [
  { path: '../../../agent-tools/cup/spawn.js' }, // work_items:write held, but allowlist filters bee
  { path: '../../../agent-tools/gym/judge.js' }, // harness:read held, but allowlist filters bee
  { path: '../../../agent-tools/gym/signals.js' }, // harness:read held, but allowlist filters bee
];

describe('bee tool boundary (P-004 — two-gate reality)', () => {
  test('the worker-bee CAN reach the unlocked engineering surface (both gates pass)', async () => {
    const caps = await loadRoleCapabilities(fakeTx(), 'ws', 'cup');
    for (const { path, via } of CAN) {
      const tool = await importTool(path);
      const r = beeReach(tool, caps);
      expect(r.roleOk, `${tool.name}: bee not in agentRoles (${tool.agentRoles?.join(',')})`).toBe(true);
      expect(r.capOk, `${tool.name}: bee missing cap ${tool.capability} (needs ${via})`).toBe(true);
      expect(r.callable, `${tool.name} should be bee-callable`).toBe(true);
    }
  });

  test('the worker-bee CANNOT reach the Queen-only admin surface — blocked at the CAPABILITY gate', async () => {
    const caps = await loadRoleCapabilities(fakeTx(), 'ws', 'cup');
    for (const { path } of CANNOT_CAP) {
      const tool = await importTool(path);
      const r = beeReach(tool, caps);
      expect(r.capOk, `${tool.name}: bee unexpectedly HOLDS cap ${tool.capability}`).toBe(false);
      expect(r.callable, `${tool.name} must NOT be bee-callable`).toBe(false);
    }
  });

  test('the worker-bee CANNOT reach the placement/optimization surface — blocked at the ROLE gate (D-002 carve-out)', async () => {
    const caps = await loadRoleCapabilities(fakeTx(), 'ws', 'cup');
    for (const { path } of CANNOT_ROLE) {
      const tool = await importTool(path);
      const r = beeReach(tool, caps);
      // These gate on a cap the bee legitimately holds, so the boundary lives in the allowlist:
      expect(r.capOk, `${tool.name}: precondition — bee should hold the gating cap ${tool.capability}`).toBe(true);
      expect(r.roleOk, `${tool.name}: bee must be filtered OUT of agentRoles (Queen-only placement)`).toBe(false);
      expect(r.callable, `${tool.name} must NOT be bee-callable`).toBe(false);
    }
  });
});
