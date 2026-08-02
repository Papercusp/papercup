import { describe, it, expect, vi, beforeEach } from 'vitest';

// WI-6584: recordEditAttribution's plan_slug fix reads presence + the work-item claim —
// mock both seams plus the raw SQL handle so the INSERT's actual bound values are
// inspectable without a real Postgres connection.
const insertCalls: unknown[][] = [];
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: Object.assign(
      (_strings: TemplateStringsArray, ...values: unknown[]) => {
        insertCalls.push(values);
        return Promise.resolve([]);
      },
      { unsafe: () => Promise.resolve([]) },
    ),
  }),
}));

let mockClaim: { harnessSlug?: string; workItemId?: string } | null = null;
vi.mock('./work-item-claims', () => ({
  getActiveClaimForOwner: async () => mockClaim,
}));

let mockPresence: { currentPlanSlug: string | null } | null = null;
vi.mock('./agent-tools/coordination/presence', () => ({
  getPresence: async () => mockPresence,
}));

import { parsePapercuspTrailers, recordEditAttribution } from './edit-attribution';

describe('recordEditAttribution — plan_slug fill (WI-6584)', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    mockClaim = null;
    mockPresence = null;
  });

  it('fills plan_slug from the agent\'s live presence row when declared', async () => {
    mockPresence = { currentPlanSlug: 'bug-drain-nonp2p-2026-07-11' };
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    expect(insertCalls).toHaveLength(1);
    // SELECT $1, f, $2, $3, $4, $5, $6, $7, $8, $9 FROM unnest($10::text[]) — plan_slug is
    // the 8th bound value (0-indexed 7): repoRoot, agentId, sessionId, contributor,
    // workspaceId, harnessSlug, workItemId, planSlug, intent, files.
    expect(insertCalls[0][7]).toBe('bug-drain-nonp2p-2026-07-11');
  });

  it('leaves plan_slug null when the agent has no declared plan (never guesses)', async () => {
    mockPresence = { currentPlanSlug: null };
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    expect(insertCalls[0][7]).toBeNull();
  });

  it('leaves plan_slug null when presence lookup fails (best-effort, never throws)', async () => {
    mockPresence = null; // simulate no presence row / lookup miss
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    expect(insertCalls[0][7]).toBeNull();
  });

  it('still fills harnessSlug/workItemId from the claim alongside plan_slug from presence', async () => {
    mockClaim = { harnessSlug: 'papercusp', workItemId: 'WI-6584' };
    mockPresence = { currentPlanSlug: 'my-plan' };
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    const [, , , , , harnessSlug, workItemId, planSlug] = insertCalls[0];
    expect(harnessSlug).toBe('papercusp');
    expect(workItemId).toBe('WI-6584');
    expect(planSlug).toBe('my-plan');
  });
});

describe('parsePapercuspTrailers (deterministic-commit-workitem-attribution P-004)', () => {
  it('parses Papercusp-Agent/Work-Item/Session/Plan from a per-agent commit body', () => {
    const body = [
      'fix a [skip ci]',
      '',
      'Co-Authored-By: ag1 <ag1@agents.papercusp>',
      'Papercusp-Agent: su-abc',
      'Papercusp-Work-Item: WI-1, WI-2',
      'Papercusp-Session: sess-9',
      'Papercusp-Plan: plan-x',
    ].join('\n');
    expect(parsePapercuspTrailers(body)).toEqual({
      agent: 'su-abc',
      workItems: ['WI-1', 'WI-2'],
      sessionId: 'sess-9',
      planSlug: 'plan-x',
    });
  });

  it('returns empty workItems and no fields for a plain (un-attributed) commit', () => {
    expect(parsePapercuspTrailers('chore(git-sync): auto-commit [skip ci]')).toEqual({ workItems: [] });
  });

  it('tolerates a single work-item and missing optional trailers', () => {
    const body = 'subj\n\nPapercusp-Agent: a\nPapercusp-Work-Item: WI-9';
    expect(parsePapercuspTrailers(body)).toEqual({ agent: 'a', workItems: ['WI-9'] });
  });

  it('round-trips the exact trailer lines run-git-sync writes', () => {
    // mirrors the `-m` values commitAttributedGroups pushes onto `git commit`.
    const body = ['s', '', 'Papercusp-Agent: ag', 'Papercusp-Work-Item: WI-1, WI-2'].join('\n');
    const p = parsePapercuspTrailers(body);
    expect(p.agent).toBe('ag');
    expect(p.workItems).toEqual(['WI-1', 'WI-2']);
  });

  it('ignores a Papercusp-Work-Item with empty/whitespace tokens', () => {
    expect(parsePapercuspTrailers('s\n\nPapercusp-Work-Item: , WI-1 ,').workItems).toEqual(['WI-1']);
  });

  it('handles an empty / undefined body without throwing', () => {
    expect(parsePapercuspTrailers('')).toEqual({ workItems: [] });
    expect(parsePapercuspTrailers(undefined as unknown as string)).toEqual({ workItems: [] });
  });
});
