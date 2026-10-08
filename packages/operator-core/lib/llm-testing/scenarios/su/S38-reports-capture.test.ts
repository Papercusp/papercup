import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import { REPORT_BODY, SU_S38_REPORTS_CAPTURE, createReportsCaptureWorld } from './S38-reports-capture';
import { REPORT_BODY_MAX_BYTES } from '../../../report-library';

function violations(calls: Array<{ name: string; input: Record<string, unknown>; responseIndex?: number }>, outputs?: unknown[]) {
  const run = { turns: [{ toolCalls: calls.map((call, index) => ({ responseIndex: index, ...call })),
    toolResults: calls.map((call, index) => ({ name: call.name, isError: false, truncated: false,
      output: JSON.stringify(outputs?.[index] ?? ((call.name === 'reports:publish' || call.input.name === 'reports:publish')
        ? { ok: true, report_id: 'rpt_fixture' }
        : { ok: true, results: [{ id: 'rpt_fixture', ok: true, report: { body_md: REPORT_BODY, visibility: 'owner' } }] })) }))
  }] } as unknown as RunSummary;
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
    const calls = [{ name: 'reports:publish', input: { title: 'Architecture review', kind: 'review', body_md: REPORT_BODY, visibility: 'owner' } },
      { name: 'reports:get', input: { id: 'rpt_fixture' } }];
    expect(violations(calls)).toEqual([]);
    expect(violations(calls.map(call => ({ name: 'tools:invoke', input: { name: call.name, args: call.input } })))).toEqual([]);
  });

  it('rejects a missing read-back, altered Markdown, or broader visibility', () => {
    expect(violations([{ name: 'reports:publish', input: { title: 'Review', body_md: REPORT_BODY } }])).toHaveLength(1);
    for (const input of [{ title: 'Review', body_md: REPORT_BODY.replace('```mermaid', '```text') },
      { title: 'Review', body_md: REPORT_BODY, visibility: 'workspace' },
      { title: 'Review', body_md: REPORT_BODY, kind: 'architecture-review' },
      { body_md: REPORT_BODY }, { title: '', body_md: REPORT_BODY }]) {
      expect(violations([{ name: 'reports:publish', input },
        { name: 'reports:get', input: { ids: ['rpt_fixture'] } }])).toHaveLength(1);
    }
  });

  it('rejects a read-back that precedes publication', () => {
    expect(violations([{ name: 'reports:get', input: { id: 'rpt_fixture' } },
      { name: 'reports:publish', input: { title: 'Review', body_md: REPORT_BODY } }])).toHaveLength(1);
  });

  it('requires successful publication and a complete private read-back across a tool-result boundary', () => {
    const calls = [{ name: 'reports:publish', input: { title: 'Review', body_md: REPORT_BODY } },
      { name: 'reports:get', input: { id: 'rpt_fixture' } }];
    expect(violations(calls)).toEqual([]);
    expect(violations(calls.map(call => ({ ...call, responseIndex: 0 })))).toHaveLength(1);
    expect(violations(calls, [{ ok: false, error: 'invalid_field' }])).toHaveLength(1);
    for (const output of [{ ok: false, error: 'not_found' },
      { ok: true, results: [{ id: 'rpt_fixture', ok: true, report: { body_md: '# Altered', visibility: 'owner' } }] },
      { ok: true, results: [{ id: 'rpt_fixture', ok: true, report: { body_md: REPORT_BODY, visibility: 'workspace' } }] }]) {
      expect(violations(calls, [{ ok: true, report_id: 'rpt_fixture' }, output])).toHaveLength(1);
    }
  });

  it('refuses production-invalid publications and cannot invent a successful read-back', async () => {
    for (const input of [{ title: 'Review', body_md: REPORT_BODY, kind: 'architecture-review' },
      { body_md: REPORT_BODY }, { title: '', body_md: REPORT_BODY },
      { title: 'Review', body_md: REPORT_BODY, visibility: 'public' },
      { title: 'Review', body_md: REPORT_BODY, subject: { kind: 'plan' } },
      { title: 'Review', body_md: 'x'.repeat(REPORT_BODY_MAX_BYTES + 1) }]) {
      const world = createReportsCaptureWorld();
      const published = await world.override('reports:publish', input);
      expect(JSON.parse((published as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false });
      const read = await world.override('reports:get', { id: 'rpt_fixture' });
      expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text)).toMatchObject({
        ok: false, results: [{ id: 'rpt_fixture', ok: false, error: 'not_found' }], counts: { ok: 0, failed: 1 } });
    }
  });

  it('reads only the saved body and visibility by the published id', async () => {
    const world = createReportsCaptureWorld();
    const body = '# Distinct body';
    await world.override('reports:publish', { title: 'Review', body_md: body, kind: 'review', visibility: 'pot' });
    const read = await world.override('reports:get', { id: 'rpt_fixture' });
    expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text)).toMatchObject({
      ok: true, results: [{ report: { body_md: body, visibility: 'pot' } }] });
    const wrongId = await world.override('reports:get', { id: 'rpt_other' });
    expect(JSON.parse((wrongId as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false });
  });
});
