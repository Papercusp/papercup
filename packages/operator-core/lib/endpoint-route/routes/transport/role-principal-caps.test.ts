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

  test('an ordinary pipeline role with no row stays empty (least-privilege)', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'worker');
    expect(caps.size).toBe(0);
  });

  test('operator: a provisioned row is unioned with the pot-decider baseline', async () => {
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

  test('operator with NO row gets the full pot-decider baseline (fresh workspace, pre-provision)', async () => {
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
      'routines:write', // pot:declare-wake
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
