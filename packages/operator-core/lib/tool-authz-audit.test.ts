/**
 * Coverage for recordToolAuthzEvent — the tool resource-authz audit sink. The
 * org-PG handle is a content-capturing sql mock; asserts the event fields are
 * threaded into the INSERT in order, null-default for absent principal/resource,
 * and that a write failure is swallowed (fire-and-forget) with a console.warn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthAuditEvent } from '@papercusp/agent-mcp';

const sql = vi.fn(() => Promise.resolve([]));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql }) };
});

import { recordToolAuthzEvent } from './tool-authz-audit';

const fullEvent: AuthAuditEvent = {
  ts: 1_700_000_000_000,
  tool: 'plans:set-status',
  action: 'write',
  decision: 'allow',
  gate: 'role',
  reason: 'operator tier',
  principal: { slug: 'agent-x', workspaceId: 'ws-1' },
  resource: { type: 'plan', id: 'P-007' },
} as unknown as AuthAuditEvent;

beforeEach(() => sql.mockClear());
afterEach(() => vi.restoreAllMocks());

describe('recordToolAuthzEvent', () => {
  it('threads the event fields into the INSERT (ts, ws, slug, tool, action, resType, resId, decision, gate, reason)', async () => {
    await recordToolAuthzEvent(fullEvent);
    expect(sql).toHaveBeenCalledOnce();
    const values = (sql.mock.calls[0] as unknown as unknown[]).slice(1);
    expect(values).toEqual([
      1_700_000_000_000,
      'ws-1',
      'agent-x',
      'plans:set-status',
      'write',
      'plan',
      'P-007',
      'allow',
      'role',
      'operator tier',
    ]);
  });

  it('null-defaults absent principal / resource / reason', async () => {
    await recordToolAuthzEvent({
      ts: 1,
      tool: 't',
      action: 'a',
      decision: 'deny',
      gate: 'capability',
    } as unknown as AuthAuditEvent);
    const values = (sql.mock.calls[0] as unknown as unknown[]).slice(1);
    expect(values).toEqual([1, null, null, 't', 'a', null, null, 'deny', 'capability', null]);
  });

  it('swallows a write failure (fire-and-forget) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sql.mockRejectedValueOnce(new Error('pg down'));
    await expect(recordToolAuthzEvent(fullEvent)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
