import { describe, expect, it } from 'vitest';
import { classifyMcpBody, classifyMcpRequest, evaluateAdmission } from './mcp-admission';

const auditArgs = {
  rubricRef: 'grading-integrity',
  ratings: { criterion: { rating: 'pass', evidence: 'bounded audit evidence' } },
  terminal: true,
  subject: { kind: 'scorecard', ref: 'EI-CARD' },
};

const evaluateArgs = {
  rubricRef: 'grading-integrity',
  sourceHive: 'papercusp',
  ratings: {
    criterion: { rating: 'pass', evidence: 'bounded grading evidence' },
  },
};

function toolsCall(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

function request(body: string, role = 'judge'): Request {
  return new Request(`http://127.0.0.1:3070/api/mcp?role=${role}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('judge grading-integrity admission reserve', () => {
  it.each([
    ['canonical', 'scorecards:evaluate'],
    ['underscore', 'scorecards_evaluate'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_evaluate'],
  ])('admits one bounded complete evaluation for a judge under critical pressure: %s', async (_label, name) => {
    const body = toolsCall(0, name, evaluateArgs);
    const req = request(body);

    expect(classifyMcpBody(body, req.url)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, req.url)).toBe('diagnostic');
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });

  it('admits the bounded complete evaluation through deferred tools:invoke', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__scorecards_evaluate', args: evaluateArgs },
      },
    });
    const req = request(body);

    expect(classifyMcpBody(body, req.url)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, req.url)).toBe('diagnostic');
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });

  it('keeps complete evaluations sheddable outside the judge role or when oversized', async () => {
    const nonJudge = request(toolsCall(0, 'scorecards:evaluate', evaluateArgs), 'worker');
    expect(classifyMcpBody(await nonJudge.clone().text(), nonJudge.url)).toEqual({ sheddable: true, id: 0 });
    expect(await evaluateAdmission(nonJudge, 'critical', true)).not.toBeNull();

    const oversized = request(
      toolsCall(0, 'scorecards:evaluate', {
        ...evaluateArgs,
        ratings: { criterion: { rating: 'pass', evidence: 'x'.repeat(4_001) } },
      }),
    );
    expect(await evaluateAdmission(oversized, 'critical', true)).not.toBeNull();
  });

  it('admits one terminal scorecard audit for a judge under critical pressure', async () => {
    const body = toolsCall(1, 'scorecards:emit', auditArgs);
    const req = request(body);

    expect(classifyMcpBody(body, req.url)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, req.url)).toBe('diagnostic');
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });

  it('admits the same bounded audit through deferred tools:invoke', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__scorecards_emit', args: auditArgs },
      },
    });
    const req = request(body);

    expect(classifyMcpBody(body, req.url)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, req.url)).toBe('diagnostic');
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });

  it('keeps ordinary, non-terminal, and non-audit scorecard writes sheddable', async () => {
    const cases = [
      { role: 'worker', args: auditArgs },
      { role: 'judge', args: { ...auditArgs, terminal: false } },
      { role: 'judge', args: { ...auditArgs, rubricRef: 'goal-mode-e2e' } },
      { role: 'judge', args: { ...auditArgs, subject: { kind: 'plan', ref: 'plan-1' } } },
    ];

    for (const [index, item] of cases.entries()) {
      const body = toolsCall(index + 3, 'scorecards:emit', item.args);
      const req = request(body, item.role);
      expect(classifyMcpBody(body, req.url)).toEqual({ sheddable: true, id: index + 3 });
      expect(classifyMcpRequest(body, req.url)).toBe('ordinary');
      expect(await evaluateAdmission(req, 'critical', true)).not.toBeNull();
    }
  });
});
