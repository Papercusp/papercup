import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));

import {
  hasPotentialActionClaim,
  normalizeActionToolName,
  provesActionClaim,
  readSuccessfulActionInvocations,
  stableActionTargets,
  suppressProvenActionClaims,
} from './carry-surface-action-proof';
import { lintCarrySurfaceProvenance } from './carry-surface-provenance-lint';

beforeEach(() => sql.mockReset());

describe('carry-surface same-turn action proof', () => {
  it('normalizes telemetry tool names and extracts concrete targets only', () => {
    expect(normalizeActionToolName('mcp__papercusp_su__coord_send')).toBe('coord:send');
    expect(stableActionTargets({ to: ['su-bce40c51'], body: 'WI-5672 posts 53500' })).toEqual([
      'su-bce40c51',
      'WI-5672',
      'post:53500',
    ]);
    expect(stableActionTargets({ await_id: 91951, msg_id: 'mt7t2ba2-0000' })).toEqual([]);
  });

  it('requires a stable target overlap and the expected action tool', () => {
    expect(hasPotentialActionClaim('Messaged fleet leader su-bce40c51 directly')).toBe(true);
    expect(
      provesActionClaim('Messaged fleet leader su-bce40c51 directly', {
        toolName: 'coord:send',
        args: { to: ['su-bce40c51'], body: 'handoff' },
      }),
    ).toBe(true);
    expect(
      provesActionClaim('Messaged fleet leader su-bce40c51 directly', {
        toolName: 'coord:send',
        args: { to: ['su-deadbeef'] },
      }),
    ).toBe(false);
    expect(
      provesActionClaim('Messaged fleet leader su-bce40c51 directly', {
        toolName: 'work_items:comment',
        args: { id: 'WI-7' },
      }),
    ).toBe(false);
  });

  it('suppresses only a proven first-person match', () => {
    const current = lintCarrySurfaceProvenance(
      ['Messaged fleet leader su-bce40c51 directly', 'su-deadbeef replied about WI-7'].join('\n'),
    );
    const filtered = suppressProvenActionClaims(current, [
      { toolName: 'coord:send', args: { to: ['su-bce40c51'] } },
    ]);
    expect(filtered?.matches).toEqual([{ line: 'su-deadbeef replied about WI-7', kind: 'peer-reported-action' }]);
  });

  it('does not treat a returned msg/await id as argument proof', () => {
    const current = lintCarrySurfaceProvenance('Sent msg mt7t2ba2-0000 to the peer');
    const filtered = suppressProvenActionClaims(current, [
      { toolName: 'coord:send', args: { to: ['su-bce40c51'], summary: 'handoff' } },
    ]);
    expect(filtered?.matches[0]?.kind).toBe('unverified-action-claim');
  });

  it('reads bounded successful rows scoped to concrete workspace and spawn', async () => {
    sql.mockResolvedValue([{ tool_name: 'coord:send', args_json: { to: ['su-bce40c51'] } }]);
    const rows = await readSuccessfulActionInvocations({
      workspaceId: 'ws-1',
      spawnId: 'spawn-1',
      coordOwnerId: 'su-owner',
    });
    expect(rows).toEqual([{ toolName: 'coord:send', args: { to: ['su-bce40c51'] } }]);
    const query = String(sql.mock.calls[0]?.[0]?.join(' '));
    expect(query).toContain('workspace_id');
    expect(query).toContain('spawn_id');
    expect(query).not.toContain('coord_owner_id =');
    expect(query).toContain("status = 'ok'");
    expect(query).toContain('LIMIT');
  });

  it('falls back to the stable coordination owner when the spawn has no current rows', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { tool_name: 'coord:send', args_json: { to: ['su-bce40c51'] } },
    ]);

    const rows = await readSuccessfulActionInvocations({
      workspaceId: 'ws-1',
      spawnId: 'ephemeral-spawn',
      coordOwnerId: 'su-owner',
    });

    expect(rows).toEqual([{ toolName: 'coord:send', args: { to: ['su-bce40c51'] } }]);
    expect(sql).toHaveBeenCalledTimes(2);
    const fallbackQuery = String(sql.mock.calls[1]?.[0]?.join(' '));
    expect(fallbackQuery).toContain('coord_owner_id');
    expect(fallbackQuery).not.toContain('spawn_id =');
  });

  it('uses the stable coordination owner when spawn_id is absent', async () => {
    sql.mockResolvedValue([{ tool_name: 'events:await', args_json: { event: 'work-item:done:EI-7' } }]);

    const rows = await readSuccessfulActionInvocations({ workspaceId: 'ws-1', coordOwnerId: 'su-owner' });

    expect(rows).toEqual([{ toolName: 'events:await', args: { event: 'work-item:done:EI-7' } }]);
    expect(sql).toHaveBeenCalledTimes(1);
    const query = String(sql.mock.calls[0]?.[0]?.join(' '));
    expect(query).toContain('coord_owner_id');
    expect(query).not.toContain('spawn_id =');
  });

  it('fails soft on missing scope and ledger errors', async () => {
    await expect(readSuccessfulActionInvocations({ workspaceId: 'ws-1' })).resolves.toBeNull();
    sql.mockImplementationOnce(() => Promise.reject(new Error('ledger unavailable')));
    await expect(
      readSuccessfulActionInvocations({ workspaceId: 'ws-1', spawnId: 'spawn-1', coordOwnerId: 'su-owner' }),
    ).resolves.toBeNull();
  });
});
