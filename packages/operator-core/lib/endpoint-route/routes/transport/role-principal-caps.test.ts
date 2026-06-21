/**
 * loadRoleCapabilities — the spawned-role → capability synthesis. Pins the
 * program-blueprint role grant (coordination-ops-as-blueprint-primitives): a
 * spawned voter/advocate has no system_principals row but must still get
 * coord:write (so coord:thread-post passes the capability gate), while ordinary
 * pipeline roles keep their empty least-privilege set.
 */
import { describe, test, expect } from 'vitest';
import type { Sql } from 'postgres';
import { effectiveDispatchWorkspace, loadRoleCapabilities } from './role-principal-caps.js';

/** A fake `tx` tagged-template that returns a fixed row set regardless of query. */
function fakeTx(rows: Array<{ capabilities: unknown }>): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

describe('loadRoleCapabilities', () => {
  test('voter (no system_principals row) gets the program-blueprint baseline incl. coord:write', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'papercusp-workspace', 'voter');
    expect(caps.has('coord:write')).toBe(true);
    expect(caps.has('coord:read')).toBe(true);
    expect(caps.has('docs:read')).toBe(true);
    expect(caps.has('search:read')).toBe(true);
  });

  test('advocate gets coord:write too', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'advocate');
    expect(caps.has('coord:write')).toBe(true);
  });

  test("scanner's OUTPUT CONTRACT is reachable: caps grant coord:write AND improvements:capture allowlists the role (P-009 smoke regression)", async () => {
    // The capability half: the scan launch blueprint's scanner gets coord:write
    // (improvements:capture's declared capability) from BLUEPRINT_ROLE_CAPS.
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'scanner');
    expect(caps.has('coord:write')).toBe(true);
    expect(caps.has('harness:read')).toBe(true);
    // The ALLOWLIST half — the one the live smoke caught missing: capability
    // alone is not enough; the tool's per-role allowlist must include scanner
    // or the tool never appears in its projected surface and findings can't
    // land as work_items (the D-005 output contract).
    const { default: capture } = await import('../../../agent-tools/improvements/capture.js');
    expect(capture.agentRoles).toContain('scanner');
  });

  test('scanner (launch-blueprint role) gets coord:write + the read caps it scans with', async () => {
    // unify-agent-launches-as-blueprints D-005: the scan blueprint's scanner reads
    // harness/plans/search state and captures findings via improvements:capture
    // (coord:write) into the self-improvement backlog.
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'scanner');
    expect(caps.has('coord:write')).toBe(true); // improvements:capture
    expect(caps.has('harness:read')).toBe(true);
    expect(caps.has('plans:read')).toBe(true);
    expect(caps.has('search:read')).toBe(true);
  });

  // ── bee — the generic fleet IMPLEMENTER (OWNER-PRIORITY fs-write/bash fix, 2026-06-15) ──
  describe('bee — the IMPLEMENTER surface (can write code + run bash)', () => {
    test('bee gets capability:fs-write + capability:bash so it can LAND a fix, not just diagnose', async () => {
      // The EI-524 read-only confinement was lifted at the ENVELOPE layer; this pins
      // the matching capability GRANT (the two-gate fix) so a future re-confinement is
      // a DELIBERATE test change, never a silent regression that re-strands the fleet.
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'bee');
      expect(caps.has('capability:fs-write')).toBe(true); // capability:write + capability:edit
      expect(caps.has('capability:bash')).toBe(true); // capability:bash + :bash_output + :bash_kill
      // ...alongside the engineering surface it already had (parity with psu).
      expect(caps.has('work_items:write')).toBe(true);
      expect(caps.has('plans:write')).toBe(true);
      expect(caps.has('harness:write')).toBe(true);
    });
  });

  // ── sentinel — the fleet watcher (unify-launch-mechanics-2026-06-09 D-004) ──
  describe('sentinel — the read-mostly fleet watcher surface', () => {
    test("sentinel's WATCH+ALARM contract is reachable: read caps + coord:write, AND fleet:assignments allowlists it", async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      // Reads it sweeps with.
      expect(caps.has('coord:read')).toBe(true);
      expect(caps.has('harness:read')).toBe(true);
      expect(caps.has('work_items:read')).toBe(true);
      expect(caps.has('activity:read')).toBe(true);
      expect(caps.has('search:read')).toBe(true);
      // The alarm channel: coord:write (coord:escalate/send).
      expect(caps.has('coord:write')).toBe(true);
      // The two-gate other half — the watcher tools must allowlist sentinel, else
      // the read caps are INERT (the bee/scanner lesson).
      const { default: assignments } = await import('../../../agent-tools/fleet/assignments.js');
      expect(assignments.agentRoles).toContain('sentinel');
      const { default: health } = await import('../../../agent-tools/harness/health.js');
      expect(health.agentRoles).toContain('sentinel');
    });

    // ── Sentinel-as-Herald: the watcher is re-homed onto the always-on, voice-first
    // Herald. It gains a USER-FACING surface (converse + voice + file-a-work_item +
    // nudge), but the hard boundary holds: it suggests + files + hands off; the
    // QUEEN places/executes. ──
    test("Herald CONVERSE contract is reachable: operator:converse cap AND the converse tool allowlists sentinel", async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      // The brain runs with role='sentinel' (the operator-converse route resolves
      // `${role}:converse`); the cap + the allowlist are the two gates.
      expect(caps.has('operator:converse')).toBe(true);
      const { default: converse } = await import('../../../agent-tools/operator/converse.js');
      expect(converse.agentRoles).toContain('sentinel');
      expect(converse.agentRoles).toContain('operator'); // unchanged for the operator
    });

    test('Herald VOICE contract is reachable: operator:read/write caps AND the voice:* tools allowlist sentinel', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      expect(caps.has('operator:read')).toBe(true); // voice:status / voice:transcript
      expect(caps.has('operator:write')).toBe(true); // voice:join / leave / channels / agent
      const { default: join } = await import('../../../agent-tools/voice/join.js');
      expect(join.agentRoles).toContain('sentinel');
      const { default: status } = await import('../../../agent-tools/voice/status.js');
      expect(status.agentRoles).toContain('sentinel');
    });

    test('Herald can FILE the user’s ask: work_items:write cap AND work_items:create/set_priority admit sentinel (via COORD_ROLES)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      expect(caps.has('work_items:write')).toBe(true);
      const { default: create } = await import('../../../agent-tools/work_items/create.js');
      expect(create.agentRoles).toContain('sentinel');
      const { default: setPriority } = await import('../../../agent-tools/work_items/set_priority.js');
      expect(setPriority.agentRoles).toContain('sentinel');
    });

    test('Herald can NUDGE the Queen: coord:write cap AND coord:send/escalate admit sentinel (via COORD_ROLES)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      expect(caps.has('coord:write')).toBe(true);
      const { default: send } = await import('../../../agent-tools/coordination/tools/send.js');
      expect(send.agentRoles).toContain('sentinel');
      const { default: escalate } = await import('../../../agent-tools/coordination/tools/escalate.js');
      expect(escalate.agentRoles).toContain('sentinel');
    });

    test('Herald reads the live blackboard it narrates: curation:read + plans:read caps (+ plans:attention allowlists it)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      expect(caps.has('curation:read')).toBe(true); // curation:feed / state-of-hive / change-feed (capability-only, no allowlist)
      expect(caps.has('plans:read')).toBe(true);
      const { default: attention } = await import('../../../agent-tools/plans/attention.js');
      expect(attention.agentRoles).toContain('sentinel');
    });

    test('sentinel still NEVER places/executes: no set_state / harness / plan / routine WRITE caps (suggest + hand off, do not act)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'sentinel');
      // It CAN file work_items (work_items:write → create/set_priority) but the
      // PLACEMENT verbs stay the Queen's: it gets no harness/plan/routine write.
      expect(caps.has('harness:write')).toBe(false);
      expect(caps.has('plans:write')).toBe(false);
      expect(caps.has('routines:write')).toBe(false);
    });

    test('sentinel CANNOT place/execute: carved OUT of fleet:spawn + DENIED fs-write/bash at the envelope', async () => {
      const { default: spawn } = await import('../../../agent-tools/fleet/spawn.js');
      expect(spawn.agentRoles).not.toContain('sentinel');
      // ...but the Queen (operator) still spawns it.
      expect(spawn.agentRoles).toContain('operator');
      // The envelope belt: even a tool asking for fs-write/bash is refused.
      const { evaluateCapabilityEnvelope } = await import('../../../capability-envelope/policy.js');
      const prev = process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
      process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = 'off';
      try {
        expect(
          evaluateCapabilityEnvelope({
            toolName: 'capability:write',
            capabilities: ['capability:fs-write'],
            ctx: { role: 'sentinel' },
          }).withinEnvelope,
        ).toBe(false);
        expect(
          evaluateCapabilityEnvelope({
            toolName: 'capability:bash',
            capabilities: ['capability:bash'],
            ctx: { role: 'sentinel' },
          }).withinEnvelope,
        ).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
        else process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = prev;
      }
    });
  });

  // ── overwatch — the autonomous system-health supervisor (overwatch-role-2026-06-15 C-2 / B-01) ──
  describe('overwatch — the read-everything + nudge/observe/escalate surface', () => {
    test("overwatch's WATCH+NUDGE contract is reachable: broad read caps + coord:write, AND the watcher tools allowlist it", async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'overwatch');
      // The broad read surface it senses the whole system with.
      for (const c of [
        'coord:read',
        'harness:read',
        'work_items:read',
        'intel:read',
        'plans:read',
        'notifications:read',
        'activity:read',
        'search:read',
      ]) {
        expect(caps.has(c), `overwatch missing read cap ${c}`).toBe(true);
      }
      // The nudge/observe/escalate channel + the directed-message channel.
      expect(caps.has('coord:write')).toBe(true); // coord:send / coord:escalate / improvements:capture
      expect(caps.has('messages:write')).toBe(true); // messages:send
      // The two-gate other half — the read+nudge tools must allowlist overwatch, else the
      // caps are INERT (the bee/scanner/sentinel lesson). One representative per gate kind:
      const { default: hiveStatus } = await import('../../../agent-tools/hive/status.js');
      expect(hiveStatus.agentRoles).toContain('overwatch'); // via COORD_ROLES
      const { default: governor } = await import('../../../agent-tools/dev/rate_governor_status.js');
      expect(governor.agentRoles).toContain('overwatch'); // explicit allowlist
      const { default: notifications } = await import('../../../agent-tools/operator/notifications_recent.js');
      expect(notifications.agentRoles).toContain('overwatch'); // [...SU_ROLES, 'overwatch']
      const { default: capture } = await import('../../../agent-tools/improvements/capture.js');
      expect(capture.agentRoles).toContain('overwatch'); // via COORD_ROLES — observations land
    });

    test('overwatch is READ + NUDGE only: no work/harness/plan/routine WRITE caps (nudge the Queen, never re-place — D-001)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'overwatch');
      expect(caps.has('work_items:write')).toBe(false);
      expect(caps.has('harness:write')).toBe(false);
      expect(caps.has('plans:write')).toBe(false);
      expect(caps.has('routines:write')).toBe(false);
    });

    test('overwatch is carved OUT of placement/optimization (fleet:spawn + gym:judge — D-001/D-002)', async () => {
      const { default: spawn } = await import('../../../agent-tools/fleet/spawn.js');
      expect(spawn.agentRoles).not.toContain('overwatch'); // placement is the Queen's; it NUDGES her
      const { default: judge } = await import('../../../agent-tools/gym/judge.js');
      expect(judge.agentRoles).not.toContain('overwatch'); // not a gym evaluator (gates on harness:read it holds)
      // ...but the Queen (operator) still places.
      expect(spawn.agentRoles).toContain('operator');
    });
  });

  test('an ordinary pipeline role with no row gets ONLY the universal tool-discovery cap (least-privilege)', async () => {
    // Pre-change this was the empty set. `agent_tools:list` is declared
    // ALL_ROLES + requirePrincipal:false and every pipeline-role persona instructs
    // calling `agent_tools:list { asRole }` as its runtime fallback playbook — so
    // every role-scoped caller gets the read-only `agent_tools:read` introspection
    // cap. The least-privilege intent is preserved for everything else: a bare
    // pipeline role still gets NO workflow caps (no coord/work_items/harness/…).
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'worker');
    expect(caps.has('agent_tools:read')).toBe(true);
    expect(caps.has('coord:write')).toBe(false);
    expect(caps.has('work_items:write')).toBe(false);
    expect(caps.has('harness:write')).toBe(false);
    expect(caps.size).toBe(1);
  });

  test('operator: a provisioned row is unioned with the hive-decider baseline', async () => {
    // autoloop-pot-operator-rebuild-2026-06-05 P-004: operator became a
    // blueprint-declared role (the pot's decider), so a STALE provisioned row
    // (pre-P-004 caps) still gets the superpower/survey baseline unioned in.
    const caps = await loadRoleCapabilities(
      fakeTx([{ capabilities: ['messages:write', 'chat:write'] }]),
      'ws',
      'operator',
    );
    expect(caps.has('messages:write')).toBe(true); // from the row
    expect(caps.has('chat:write')).toBe(true); // from the row
    expect(caps.has('harness:write')).toBe(true); // baseline — harness:create / blueprint:extend
    expect(caps.has('coord:write')).toBe(true); // baseline — survey/coord surface
  });

  test('operator with NO row gets the full hive-decider baseline (fresh workspace, pre-provision)', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'operator');
    for (const c of [
      'harness:read', // blueprint:catalog / blueprint:validate / harness:status
      'harness:write', // blueprint:extend / harness:create
      'work_items:read',
      'work_items:write',
      'curation:read',
      'activity:read',
      'coord:read',
      'coord:write',
      'plans:read',
      'routines:write', // hive:declare-wake
    ]) {
      expect(caps.has(c), `missing ${c}`).toBe(true);
    }
  });

  test('a blueprint role WITH a row gets the union of both', async () => {
    const caps = await loadRoleCapabilities(
      fakeTx([{ capabilities: ['something:read'] }]),
      'ws',
      'voter',
    );
    expect(caps.has('something:read')).toBe(true); // from the row
    expect(caps.has('coord:write')).toBe(true); // from the baseline
  });

  // bee-capability-expansion-2026-06-08 (P-002 / D-001 / D-005): the generic Hive
  // worker `bee` carries the worker ENGINEERING surface. This is the CAPABILITY half
  // of the boundary (necessary, not sufficient — the agentRoles allowlist is the
  // independent co-gate, asserted empirically in the dispatch-stack boundary test).
  describe("bee — the worker engineering cap set", () => {
    test('grants the engineering caps added by the expansion (incl. plans:write, D-005)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'bee');
      for (const c of [
        // pre-existing worker surface
        'harness:read',
        'harness:write',
        'work_items:read',
        'work_items:write',
        'coord:read',
        'coord:write',
        'plans:read',
        'docs:read',
        'search:read',
        'memory:read',
        'memory:write',
        'tasks:read',
        'tasks:write',
        // added by bee-capability-expansion
        'intel:read',
        'locks:read',
        'locks:write',
        'docs:write',
        'issues:read',
        'plans:write',
      ]) {
        expect(caps.has(c), `bee missing ${c}`).toBe(true);
      }
    });

    test('does NOT grant the Queen-only capabilities (D-002)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'bee');
      // Placement / steering / admin / judgment surfaces stay with the Queen
      // (a kind:'hive' bee). These are withheld at the CAPABILITY layer — the
      // bee never holds the cap, so the capability-check gate denies regardless
      // of any allowlist.
      for (const c of [
        'operator:converse',
        'autoloop:write',
        'routines:write',
        'curation:read',
        'processes:kill',
        'activity:report',
        'secrets:read',
        'backup:write',
        'plugins:write',
        'discovery:write',
      ]) {
        expect(caps.has(c), `bee should NOT have ${c}`).toBe(false);
      }
    });
  });
});

describe('effectiveDispatchWorkspace — EI-30 superuser per-call workspace', () => {
  test('unscoped superuser + concrete workspace arg → dispatches under the arg workspace', () => {
    expect(
      effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, { workspace: 'papercusp-workspace' }),
    ).toBe('papercusp-workspace');
  });

  test('unscoped superuser without a workspace arg → stays "*" (built-ins still fail with the scoped error)', () => {
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, {})).toBe('*');
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, undefined)).toBe('*');
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, { workspace: '' })).toBe('*');
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, { workspace: 42 })).toBe('*');
  });

  test('session-scoped superuser keeps the SESSION workspace — the arg never overrides a concrete scope', () => {
    expect(
      effectiveDispatchWorkspace({ workspaceId: 'default', isSuperuser: true }, { workspace: 'other-ws' }),
    ).toBe('default');
  });

  test('non-superuser callers are never re-scoped by the arg', () => {
    expect(effectiveDispatchWorkspace({ workspaceId: '*' }, { workspace: 'sneaky' })).toBe('*');
    expect(
      effectiveDispatchWorkspace({ workspaceId: 'ws-1', isSuperuser: false }, { workspace: 'sneaky' }),
    ).toBe('ws-1');
  });
});
