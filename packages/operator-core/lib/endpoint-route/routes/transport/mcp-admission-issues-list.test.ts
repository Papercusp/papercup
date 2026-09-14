/**
 * EI-23212584562156381 — a grading-integrity audit must be able to re-read
 * the authoritative issue that it is validating while the MCP worker is under
 * critical loop pressure. Keep the exception judge-only and tightly bounded;
 * the existing broad issues:list surface remains shed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMcpBody,
  classifyMcpRequest,
  evaluateAdmission,
  isBoundedJudgeIssuesListArgs,
  resetMcpAdmissionForTests,
} from './mcp-admission';

afterEach(() => resetMcpAdmissionForTests());

const ISSUE_ID = 'EI-23210361847877532';
const JUDGE_URL = 'http://127.0.0.1:3070/api/mcp?superuser=1&role=judge';

const toolsCall = (id: unknown, name: string, args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

const boundedArgs = () => ({ q: ISSUE_ID, includeBody: true, limit: 10 });

function post(body: string, url = JUDGE_URL): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('issues:list critical-pressure recovery admission', () => {
  it('accepts only the exact issue-id body read shape', () => {
    expect(isBoundedJudgeIssuesListArgs(boundedArgs())).toBe(true);

    for (const args of [
      {},
      { q: 'EI-123', limit: 10 },
      { q: 'EI-123', includeBody: false, limit: 10 },
      { q: 'EI-123', includeBody: true },
      { q: 'EI-123', includeBody: true, limit: 11 },
      { q: 'EI-123', includeBody: true, limit: 0 },
      { q: 'EI-123', includeBody: true, limit: 1.5 },
      { q: 'EI-audit-1', includeBody: true, limit: 10 },
      { q: 'title mentions EI-123', includeBody: true, limit: 10 },
      { q: 'EI-123', includeBody: true, limit: 10, scope: 'harness:papercusp' },
      { q: 'EI-123', includeBody: true, limit: 10, rollup: 'state' },
      { q: 'EI-123', includeBody: true, limit: 10, kinds: ['bug'] },
    ]) {
      expect(isBoundedJudgeIssuesListArgs(args)).toBe(false);
    }
  });

  it.each([
    ['canonical', 'issues:list'],
    ['underscore', 'issues_list'],
    ['mcp advertised', 'mcp__papercusp-su__issues_list'],
    ['mcp advertised underscore', 'mcp__papercusp_su__issues_list'],
  ])('admits a bounded direct judge read in the %s spelling', (_label, name) => {
    const body = toolsCall(1, name, boundedArgs());
    expect(classifyMcpBody(body, JUDGE_URL)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, JUDGE_URL)).toBe('diagnostic');
  });

  it('admits the bounded judge read through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__issues_list',
          args: boundedArgs(),
        },
      },
    });
    expect(classifyMcpBody(body, JUDGE_URL)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, JUDGE_URL)).toBe('diagnostic');
  });

  it('keeps non-judge, broad, and malformed reads on the pressure-shed path', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [JUDGE_URL.replace('&role=judge', '&role=worker'), boundedArgs()],
      ['http://127.0.0.1:3070/api/mcp?superuser=1', boundedArgs()],
      [JUDGE_URL, { q: ISSUE_ID, includeBody: true, limit: 10, scope: 'operator' }],
      [JUDGE_URL, { q: 'issue title', includeBody: true, limit: 10 }],
      [JUDGE_URL, { q: ISSUE_ID, includeBody: true, limit: 10, rollup: 'state' }],
    ];
    for (const [url, args] of cases) {
      const body = toolsCall(3, 'issues:list', args);
      expect(classifyMcpBody(body, url)).toEqual({ sheddable: true, id: 3 });
      expect(classifyMcpRequest(body, url)).toBe('ordinary');
    }
  });

  it('admits the exact direct request but sheds the same request outside judge routing', async () => {
    const admitted = await evaluateAdmission(post(toolsCall(9, 'issues:list', boundedArgs())), 'critical', true);
    expect(admitted).toBeNull();

    const shed = await evaluateAdmission(
      post(toolsCall(10, 'issues:list', boundedArgs()), 'http://127.0.0.1:3070/api/mcp?superuser=1'),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect(shed!.status).toBe(429);
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
});
