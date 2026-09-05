import { describe, expect, it } from 'vitest';

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { HARNESS_OVERVIEW_RESULT } from '../scenarios/su/_overrides';
import { SU_S19_OVERVIEW_STATE_OF_X } from '../scenarios/su/S19-overview-state-of-x';

interface OverviewFixture {
  harness: string;
  escalations: {
    hasEscalation: boolean;
    escalation: string;
    supervisorNotes: string;
    mtimeMs: number;
  };
  issues: {
    count: number;
    recent: Array<{ id: string; state: string }>;
  };
}

describe('SU-S19 harness:overview fixture', () => {
  it('is a complete bounded snapshot rather than advertising an omitted issue', async () => {
    const result = await HARNESS_OVERVIEW_RESULT.override('harness:overview', { harness: 'sheets' });
    expect(result).not.toBe(PASS_THROUGH);

    const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
    const body = JSON.parse(text) as OverviewFixture;

    expect(body.harness).toBe('sheets');
    expect(body.issues.count).toBe(2);
    expect(body.issues.recent).toHaveLength(body.issues.count);
    expect(body.issues.recent.map((issue) => issue.id)).toEqual(['EI-880', 'EI-881']);
    expect(body.issues.recent.every((issue) => issue.state === 'open')).toBe(true);
    expect(body.escalations).toMatchObject({
      hasEscalation: true,
      escalation: expect.stringContaining('esc-1'),
      supervisorNotes: expect.any(String),
      mtimeMs: expect.any(Number),
    });
  });

  it('keeps the scenario contract aligned with the bounded cross-cutting payload', () => {
    expect(SU_S19_OVERVIEW_STATE_OF_X.description).toContain('bounded cross-cutting open-issues snapshot');
    expect(SU_S19_OVERVIEW_STATE_OF_X.description).toContain('complete two-row issue snapshot');
  });
});
