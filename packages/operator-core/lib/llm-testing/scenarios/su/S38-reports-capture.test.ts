import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import { REPORT_BODY, SU_S38_REPORTS_CAPTURE } from './S38-reports-capture';

function violations(calls: Array<{ name: string; input: Record<string, unknown> }>) {
  const run = { turns: [{ toolCalls: calls }] } as unknown as RunSummary;
  return SU_S38_REPORTS_CAPTURE.asserts.flatMap(assert => assert.kind === 'custom' ? assert.eval(run) : []);
}

describe('S38 Reports capture contract', () => {
  it('delivers the complete review on the first turn in the declared AUTO mode', () => {
    expect(SU_S38_REPORTS_CAPTURE.targetConfig).toEqual({ modes: ['auto'] });
    const first = SU_S38_REPORTS_CAPTURE.triggers?.find(trigger => trigger.param === 0);
    expect(first).toMatchObject({ on: 'after_turn', fire: 'user_message' });
    expect(first?.text?.endsWith(REPORT_BODY)).toBe(true);
    expect(first?.text).not.toContain('docs/architecture-review.md');
  });

  it('accepts exact private publication followed by read-back through either dispatch door', () => {
    const calls = [{ name: 'reports:publish', input: { body_md: REPORT_BODY, visibility: 'owner' } },
      { name: 'reports:get', input: { id: 'rpt_fixture' } }];
    expect(violations(calls)).toEqual([]);
    expect(violations(calls.map(call => ({ name: 'tools:invoke', input: { name: call.name, args: call.input } })))).toEqual([]);
  });

  it('rejects a missing read-back, altered Markdown, or broader visibility', () => {
    expect(violations([{ name: 'reports:publish', input: { body_md: REPORT_BODY } }])).toHaveLength(1);
    for (const input of [{ body_md: REPORT_BODY.replace('```mermaid', '```text') },
      { body_md: REPORT_BODY, visibility: 'workspace' }]) {
      expect(violations([{ name: 'reports:publish', input },
        { name: 'reports:get', input: { ids: ['rpt_fixture'] } }])).toHaveLength(1);
    }
  });
});
