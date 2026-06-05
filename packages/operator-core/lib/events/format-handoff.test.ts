import { describe, it, expect } from 'vitest';
import { formatHandoff } from './format-handoff';

describe('formatHandoff', () => {
  it('renders recipients, plan, summary and next action', () => {
    const s = formatHandoff({
      to: ['su-abc', 'su-def'],
      plan_slug: 'my-plan-2026',
      summary: 'finished the parser; deferring the federation seam',
      next_action: 'wire topic federation into the inject path',
    });
    expect(s).toContain('deferred → su-abc, su-def');
    expect(s).toContain('[my-plan-2026]');
    expect(s).toContain('finished the parser');
    expect(s).toContain('next: wire topic federation');
  });

  it('falls back to "unassigned" with no recipients and "handoff" with no summary', () => {
    expect(formatHandoff({})).toContain('unassigned');
    expect(formatHandoff({})).toContain('handoff');
  });

  it('clips long fields to keep the activity lane compact', () => {
    const s = formatHandoff({ summary: 'x'.repeat(500), next_action: 'y'.repeat(500) });
    expect(s.length).toBeLessThanOrEqual(220);
  });
});
