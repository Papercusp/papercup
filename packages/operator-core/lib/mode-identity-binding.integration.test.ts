/** Real-PG mode implication rows feeding the canonical built-in identity stack. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { composeSuStackSource, suSessionBinding } from '@papercusp/orchestrator/blueprint';
import { getModes, setMode } from './modes/store';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('GOAL plus IDEATE selects authored components from persisted mode state', () => {
  let db: OrgTestDb;
  const workspaceId = 'mode-identity-p003';
  const ownerId = 'su-mode-identity-p003';
  const goalId = 'goal-mode-identity-p003';

  beforeAll(async () => {
    db = await createOrgTestDb();
    await insertGoalRow(db.adminSql, {
      id: goalId,
      workspaceId,
      installSlug: 'papercusp',
      title: 'Mode identity integration fixture',
      body: 'Verify mode state selects the same authored components.',
      status: 'active',
      killCriterion: 'The goal subject or a required mode component is lost.',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists GOAL subject and AUTO+IDEATE implications, then renders all three mode packages', async () => {
    const transition = await setMode({
      workspaceId, ownerId, modeId: 'goal', subject: goalId, enabled: true,
      reason: 'P-003 identity composition proof', setBy: ownerId, sql: db.adminSql,
    });
    expect(transition.ok).toBe(true);
    const rows = await getModes(workspaceId, ownerId, db.adminSql);
    expect(rows.map((row) => row.mode).sort()).toEqual(['auto', 'goal', 'ideate']);
    expect(rows.find((row) => row.mode === 'goal')?.subject).toBe(goalId);
    expect(rows.find((row) => row.mode === 'auto')?.impliedBy).toMatchObject({ mode: 'goal', subject: goalId });
    expect(rows.find((row) => row.mode === 'ideate')?.impliedBy).toMatchObject({ mode: 'goal', subject: goalId });
    const stack = composeSuStackSource({ binding: suSessionBinding({ modes: rows.map((row) => row.mode) }) });
    expect(stack.order.filter((entry) => entry.layer === 'modes').map((entry) => entry.id))
      .toEqual(['su.mode-auto', 'su.mode-ideate', 'su.mode-goal']);
    expect(stack.text).toContain('IDEATE × AUTO compose');
    expect(stack.text).toContain('GOAL keeps portfolio ownership and delegates every build');
    expect(stack.findings.filter((finding) => finding.tier === 'block')).toEqual([]);
  });
});
