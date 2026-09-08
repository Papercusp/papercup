import { describe, expect, it } from 'vitest';
import { classifyMcpBody, classifyMcpRequest, evaluateAdmission } from './mcp-admission';

const auditArgs = {
  rubricRef: 'grading-integrity',
  ratings: { criterion: { rating: 'pass', evidence: 'bounded audit evidence' } },
  terminal: true,
  subject: { kind: 'scorecard', ref: 'EI-CARD' },
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
