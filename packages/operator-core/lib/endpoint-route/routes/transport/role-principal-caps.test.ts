/**
 * loadRoleCapabilities — the spawned-role → capability synthesis. Pins the
 * program-blueprint role grant (coordination-ops-as-blueprint-primitives): a
 * spawned voter/advocate has no system_principals row but must still get
 * coord:write (so coord:thread-post passes the capability gate), while ordinary
 * pipeline roles keep their empty least-privilege set.
 */
import { describe, test, expect } from 'vitest';
import type { Sql } from 'postgres';
import { loadRoleCapabilities } from './role-principal-caps.js';

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

  test('a provisioned row is unioned with the baseline (operator: row only, no blueprint grant)', async () => {
    const caps = await loadRoleCapabilities(
      fakeTx([{ capabilities: ['messages:write', 'chat:write'] }]),
      'ws',
      'operator',
    );
    expect(caps.has('messages:write')).toBe(true);
    expect(caps.has('chat:write')).toBe(true);
    expect(caps.has('coord:write')).toBe(false); // operator is not a program-blueprint role
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
