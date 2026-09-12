/**
 * P-010 admission control (mcp-reliability-hardening-2026-07-11) — pin the
 * load-shed decision: only a POST tools/call is shed, only under CRITICAL loop
 * pressure, bounded diagnostics remain admitted, the body is peeked
 * NON-destructively (the handler still gets it), and the shed response is a
 * retryable 429 the proxy absorbs.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  classifyMcpBody,
  classifyMcpRequest,
  shouldShedForPressure,
  shouldShedForCapacity,
  acquireAdmission,
  withMcpAdmission,
  evaluateAdmission,
  admissionShedResponse,
  getMcpAdmissionSnapshot,
  resetMcpAdmissionForTests,
} from './mcp-admission';

afterEach(() => resetMcpAdmissionForTests());

const toolsCall = (id: unknown = 7, name = 'plans:get', args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function post(body: string): Request {
  return new Request('http://127.0.0.1:3070/api/mcp?superuser=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const judgeRequestUrl = 'http://127.0.0.1:3070/api/mcp?superuser=1&role=judge';

describe('classifyMcpBody — only a tools/call is sheddable', () => {
  it('flags a tools/call and echoes its id', () => {
    expect(classifyMcpBody(toolsCall(42))).toEqual({ sheddable: true, id: 42 });
    expect(classifyMcpBody(toolsCall('abc'))).toEqual({ sheddable: true, id: 'abc' });
  });
  it('does NOT shed cheap protocol methods', () => {
    for (const method of ['initialize', 'tools/list', 'ping', 'resources/list', 'prompts/list', 'notifications/initialized']) {
      expect(classifyMcpBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).toEqual({ sheddable: false, id: null });
    }
  });
  it.each([
    'dev:service_health',
    'dev:pg_query',
    'dev_pg_query',
    'mcp__papercusp-su__dev_pg_query',
    'mcp__papercusp_su__dev_pg_query',
    // EI-21574538947513211 — the tool used to OBSERVE loop pressure was itself being shed by
    // the pressure gate (94 retryable -32000s, reason loop_pressure_critical, on a bounded
    // 149-index ownLogProbe walk). Listed in every name form the normalizer must collapse,
    // because a client-mangled spelling reaching the gate un-normalized would silently
    // reinstate the shed.
    'dev:dogfood_substrate_status',
    'dev_dogfood_substrate_status',
    'mcp__papercusp-su__dev_dogfood_substrate_status',
  ])('does NOT shed bounded critical-pressure diagnostic %s', (name) => {
    expect(classifyMcpBody(toolsCall(11, name))).toEqual({ sheddable: false, id: null });
  });

  it.each([
    'tools:find',
    'tools_find',
    'mcp__papercusp-su__tools_find',
    'mcp__papercusp_su__tools_find',
  ])('does NOT shed catalog discovery under critical pressure: %s', (name) => {
    const body = toolsCall(11, name, { query: 'grading integrity scorecard tools' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'work_items:get',
    'work_items_get',
    'mcp__papercusp-su__work_items_get',
  ])('does NOT shed a bounded single-item work_items:get under critical pressure: %s', (name) => {
    const body = toolsCall(11, name, { id: 'EI-22381211295936796' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps bulk/detail/thread work_items:get reads sheddable under critical pressure', () => {
    for (const args of [
      { ids: ['EI-1', 'EI-2'] },
      { id: 'EI-1', detail: true },
      { id: 'EI-1', threadLimit: 1 },
    ]) {
      expect(classifyMcpBody(toolsCall(12, 'work_items:get', args))).toEqual({ sheddable: true, id: 12 });
    }
  });

  it('recognizes the bounded work_items:get through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp-su__work_items_get', args: { id: 'EI-1' } },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'work_items:checkpoint'],
    ['underscore', 'work_items_checkpoint'],
    ['mcp-advertised', 'mcp__papercusp_su__work_items_checkpoint'],
  ])('does NOT shed a single work-item checkpoint under critical pressure: %s', (_label, name) => {
    const body = toolsCall(19, name, { id: 'WI-10000745', checkpoint: 'resume from this boundary' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one-item checkpoint batches but keeps bulk or ambiguous calls sheddable', () => {
    expect(
      classifyMcpBody(
        toolsCall(20, 'work_items:checkpoint', {
          items: [{ id: 'WI-10000745', checkpoint: 'resume from this boundary' }],
        }),
      ),
    ).toEqual({ sheddable: false, id: null });
    for (const args of [
      { items: [{ id: 'WI-1' }, { id: 'WI-2' }] },
      { id: 'WI-1', items: [{ id: 'WI-2' }] },
      { checkpoint: 'missing item identity' },
    ]) {
      expect(classifyMcpBody(toolsCall(21, 'work_items:checkpoint', args))).toEqual({
        sheddable: true,
        id: 21,
      });
    }
  });

  it('recognizes a single work-item checkpoint through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_checkpoint',
          args: { id: 'WI-10000745', checkpoint: 'resume from this boundary' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'scorecards:list'],
    ['underscore', 'scorecards_list'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_list'],
  ])('does NOT shed an exact scorecard audit read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(13, name, {
      rubricRef: 'grading-integrity',
      subjectRef: 'EI-22581128473264750',
      includeSuperseded: true,
      includeRetracted: true,
      limit: 1,
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or oversized scorecards:list reads sheddable under critical pressure', () => {
    for (const args of [
      { rubricRef: 'grading-integrity' },
      { subjectRef: 'EI-22581128473264750' },
      { rubricRef: 'grading-integrity', subjectRef: 'EI-22581128473264750', limit: 26 },
    ]) {
      expect(classifyMcpBody(toolsCall(14, 'scorecards:list', args))).toEqual({ sheddable: true, id: 14 });
    }
  });

  it('recognizes the exact scorecard audit through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_list',
          args: { rubricRef: 'grading-integrity', subjectRef: 'EI-22581128473264750', limit: 1 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'scorecards:get'],
    ['underscore', 'scorecards_get'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_get'],
  ])('does NOT shed one scorecard evidence read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(29, name, { issueId: 'EI-22581128473264750' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps ambiguous or oversized scorecards:get reads sheddable under critical pressure', () => {
    for (const args of [{}, { issueId: ' ' }, { issueId: 'x'.repeat(121) }, { issueId: 'EI-1', extra: true }]) {
      expect(classifyMcpBody(toolsCall(30, 'scorecards:get', args))).toEqual({ sheddable: true, id: 30 });
    }
  });

  it('recognizes one scorecard evidence read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_get',
          args: { issueId: 'EI-22581128473264750' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'improvements:capture'],
    ['underscore', 'improvements_capture'],
    ['mcp-advertised', 'mcp__papercusp_su__improvements_capture'],
  ])('does NOT shed the bounded tool-failure capture shorthand under critical pressure: %s', (_label, name) => {
    const body = toolsCall(32, name, {
      toolFailure: {
        toolName: 'scorecards:get',
        errorCode: 'loop_pressure_critical',
        status: 429,
        message: 'operator MCP admission shed the scorecard evidence read',
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps authored, malformed, or oversized captures sheddable under critical pressure', () => {
    for (const args of [
      { title: 'operator admission shed a grading audit call', kind: 'bug' },
      {
        title: 'operator admission shed a grading audit call',
        toolFailure: { toolName: 'scorecards:get', message: 'shed' },
      },
      { toolFailure: { toolName: 'scorecards:get' } },
      { toolFailure: { toolName: 'scorecards:get', message: 'x'.repeat(4001) } },
    ]) {
      expect(classifyMcpBody(toolsCall(33, 'improvements:capture', args))).toEqual({ sheddable: true, id: 33 });
      expect(classifyMcpRequest(toolsCall(33, 'improvements:capture', args))).toBe('ordinary');
    }
  });

  it('recognizes the bounded tool-failure capture through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__improvements_capture',
          args: {
            toolFailure: { toolName: 'scorecards:get', message: 'operator MCP admission shed the read' },
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'rubrics:get'],
    ['underscore', 'rubrics_get'],
    ['mcp-advertised', 'mcp__papercusp_su__rubrics_get'],
  ])('does NOT shed a single full rubric read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(16, name, { rubricRef: 'goal-mode-e2e' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps bulk or ambiguous rubrics:get reads sheddable under critical pressure', () => {
    for (const args of [
      { rubricRefs: ['goal-mode-e2e', 'grading-integrity'] },
      { rubricRef: 'goal-mode-e2e', rubricRefs: ['grading-integrity'] },
      { revision: 3 },
    ]) {
      const body = toolsCall(17, 'rubrics:get', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 17 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a single rubric read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__rubrics_get',
          args: { rubricRef: 'goal-mode-e2e' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits only bounded judge-role audit probes under critical pressure', () => {
    const cases = [
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 1 },
      ],
      ['gates:degenerate-check', { sinceHours: 24, minDecisions: 30 }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 }],
    ] as const;
    for (const [name, args] of cases) {
      const body = toolsCall(23, name, args);
      expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('diagnostic');
    }
  });

  it('keeps generic, non-judge, and unbounded judge audit probes sheddable', () => {
    const cases = [
      ['plans:evaluate-spec-test-adequacy', { slug: 'adequacy-plan', classRef: 'plan-class-investigation' }],
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 26 },
      ],
      ['gates:degenerate-check', { sinceHours: 25 }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'] }],
    ] as const;
    for (const [name, args] of cases) {
      const body = toolsCall(24, name, args);
      expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: true, id: 24 });
      expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('ordinary');
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 24 });
    }
  });

  it('recognizes bounded judge audit probes through tools:invoke', () => {
    for (const [name, args] of [
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 1 },
      ],
      ['gates:degenerate-check', { sinceHours: 24, minDecisions: 30 }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 }],
    ] as const) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name: 'tools:invoke', arguments: { name, args } },
      });
      expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('diagnostic');
    }
  });

  it('recognizes tools:find through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__tools_find', args: { query: 'grading integrity scorecard tools' } },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['uri', { uri: 'papercusp://scratch/papercusp-workspace/result.spill', byte_offset: 0, byte_limit: 4096 }],
    ['file_path', { file_path: '/home/builduser/.papercusp/scratch/papercusp-workspace/result.spill', byte_offset: 0, byte_limit: 4096 }],
  ])('recognizes bounded scratch capability:read through tools:invoke (%s)', (_shape, args) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__capability_read', args },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['non-scratch path', { file_path: '/tmp/result.spill', byte_offset: 0, byte_limit: 4096 }],
    ['line window', { uri: 'papercusp://scratch/papercusp-workspace/result.spill', tail: 25 }],
    ['oversized page', { uri: 'papercusp://scratch/papercusp-workspace/result.spill', byte_offset: 0, byte_limit: 4097 }],
  ])('still sheds unsafe capability:read recovery shapes through tools:invoke (%s)', (_shape, args) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__capability_read', args },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 15 });
    expect(classifyMcpRequest(body)).toBe('ordinary');
  });

  // The CONTROL for the case above: the exemption must stay an allowlist, not a prefix rule.
  // `dev:` is not a licence — a neighbouring dev tool with unread per-call cost must still shed,
  // or the narrow list quietly becomes "anything named dev:*".
  it.each(['dev:pipeline_position', 'dev:restart', 'dev:processes'])(
    'STILL sheds unlisted dev tool %s (the list is an allowlist, not a dev: prefix rule)',
    (name) => {
      expect(classifyMcpBody(toolsCall(12, name))).toEqual({ sheddable: true, id: 12 });
    },
  );
  it('sheds a batch that CONTAINS a tools/call and echoes the first call id', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
    ]);
    expect(classifyMcpBody(batch)).toEqual({ sheddable: true, id: 2 });
  });
  it('still sheds an ordinary call batched beside a reserved diagnostic and echoes the ordinary id', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dev:pg_query' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plans:get' } },
    ]);
    expect(classifyMcpBody(batch)).toEqual({ sheddable: true, id: 2 });
  });
  it('unparseable body → not sheddable (never shed blind)', () => {
    expect(classifyMcpBody('not json')).toEqual({ sheddable: false, id: null });
    expect(classifyMcpBody('')).toEqual({ sheddable: false, id: null });
  });
});

describe('shouldShedForPressure — critical band only, respects the kill-switch', () => {
  it('sheds only when enabled AND critical', () => {
    expect(shouldShedForPressure('critical', true)).toBe(true);
    expect(shouldShedForPressure('elevated', true)).toBe(false); // elevated still admits
    expect(shouldShedForPressure('ok', true)).toBe(false);
    expect(shouldShedForPressure('critical', false)).toBe(false); // kill-switch
  });
});

describe('operator capacity admission — bounded classes with a diagnostic reserve', () => {
  const capacity = {
    maxInFlight: 10,
    controlPlaneReserve: 2,
    diagnosticReserve: 1,
    maxHandshakes: 2,
  };

  it('classifies ordinary calls, handshakes, and the named health probe separately', () => {
    expect(classifyMcpRequest(toolsCall(1))).toBe('ordinary');
    expect(classifyMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }))).toBe('handshake');
    expect(classifyMcpRequest(toolsCall(3, 'dev:service_health'))).toBe('diagnostic');
    expect(
      classifyMcpRequest(
        JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'initialize' }),
        'http://127.0.0.1:3070/api/mcp?client=mcp-health',
      ),
    ).toBe('diagnostic');
  });

  it('sheds ordinary calls before the reserved control-plane and diagnostic slots', () => {
    expect(
      shouldShedForCapacity(
        'ordinary',
        { inFlight: 7, ordinaryInFlight: 7, handshakesInFlight: 0, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(true); // 10 - (2 + 1) ordinary slots
    expect(
      shouldShedForCapacity(
        'handshake',
        { inFlight: 7, ordinaryInFlight: 7, handshakesInFlight: 0, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(false);
    expect(
      shouldShedForCapacity(
        'diagnostic',
        { inFlight: 9, ordinaryInFlight: 7, handshakesInFlight: 2, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(false);
  });

  it('keeps the handshake class bounded while retaining the diagnostic reserve', () => {
    expect(
      shouldShedForCapacity(
        'handshake',
        { inFlight: 8, ordinaryInFlight: 6, handshakesInFlight: 2, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(true);
    expect(
      shouldShedForCapacity(
        'diagnostic',
        { inFlight: 9, ordinaryInFlight: 7, handshakesInFlight: 2, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(false);
    expect(
      shouldShedForCapacity(
        'diagnostic',
        { inFlight: 10, ordinaryInFlight: 7, handshakesInFlight: 2, diagnosticsInFlight: 1 },
        capacity,
      ),
    ).toBe(true); // only the hard ceiling can shed diagnostics
  });

  it('leases operator work and releases it exactly once', async () => {
    const decision = await acquireAdmission(post(toolsCall(4)), 'ok', true);
    expect(decision.response).toBeNull();
    expect(decision.lease?.classification).toBe('ordinary');
    expect(getMcpAdmissionSnapshot()).toMatchObject({ inFlight: 1, ordinaryInFlight: 1 });
    decision.lease?.release();
    decision.lease?.release();
    expect(getMcpAdmissionSnapshot()).toEqual({
      inFlight: 0,
      handshakesInFlight: 0,
      diagnosticsInFlight: 0,
      ordinaryInFlight: 0,
    });
  });
});

describe('admissionShedResponse — a retryable 429 the proxy absorbs', () => {
  it('is a 429 with Retry-After and a JSON-RPC error envelope echoing the id', async () => {
    const res = admissionShedResponse(9);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1'); // default
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 9, error: { data: { retryable: true, reason: 'loop_pressure_critical' } } });
  });
  it('honors an explicit Retry-After', () => {
    expect(admissionShedResponse(null, 3).headers.get('retry-after')).toBe('3');
  });
});

describe('withMcpAdmission — handler-lifetime capacity lease', () => {
  it('holds the lease through handler completion and releases it afterward', async () => {
    let duringHandler: ReturnType<typeof getMcpAdmissionSnapshot> | undefined;
    const res = await withMcpAdmission(post(toolsCall(12)), 'ok', true, async () => {
      duringHandler = getMcpAdmissionSnapshot();
      return new Response('ok');
    });

    expect(res.status).toBe(200);
    expect(duringHandler).toMatchObject({ inFlight: 1, ordinaryInFlight: 1 });
    expect(getMcpAdmissionSnapshot()).toEqual({
      inFlight: 0,
      handshakesInFlight: 0,
      diagnosticsInFlight: 0,
      ordinaryInFlight: 0,
    });
  });

  it('releases the lease when the handler rejects', async () => {
    await expect(
      withMcpAdmission(post(toolsCall(13)), 'ok', true, async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(getMcpAdmissionSnapshot()).toEqual({
      inFlight: 0,
      handshakesInFlight: 0,
      diagnosticsInFlight: 0,
      ordinaryInFlight: 0,
    });
  });

  it('does not invoke the handler when admission sheds the request', async () => {
    let invoked = false;
    const res = await withMcpAdmission(post(toolsCall(14)), 'critical', true, async () => {
      invoked = true;
      return new Response('unexpected');
    });

    expect(res.status).toBe(429);
    expect(invoked).toBe(false);
    expect(getMcpAdmissionSnapshot()).toMatchObject({ inFlight: 0 });
  });
});

describe('evaluateAdmission — end-to-end gate against a real Request', () => {
  it('sheds a POST tools/call under critical pressure and does NOT consume the body', async () => {
    const req = post(toolsCall(5));
    const res = await evaluateAdmission(req, 'critical', true);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    // The gate peeked via req.clone() — the ORIGINAL body must still be readable by the handler.
    const passthroughBody = await req.text();
    expect(JSON.parse(passthroughBody).method).toBe('tools/call');
  });
  it('admits (null) when pressure is only elevated', async () => {
    expect(await evaluateAdmission(post(toolsCall()), 'elevated', true)).toBeNull();
  });
  it('admits (null) a non-tools/call even under critical pressure', async () => {
    const req = post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });
  it('admits bounded dev:pg_query under critical pressure so recovery diagnostics stay live', async () => {
    const req = post(toolsCall(6, 'dev:pg_query'));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('dev:pg_query');
  });
  // EI-21574538947513211: the end-to-end shape of the reported failure. Asserted through
  // evaluateAdmission (not just the pure classifier) because the reported symptom was a real
  // 429 with reason 'loop_pressure_critical' reaching the caller — the classifier being right
  // would not have been enough if the gate still shed it downstream.
  it('admits dev:dogfood_substrate_status under critical pressure — the tool that OBSERVES the pressure must not be shed by it', async () => {
    const req = post(toolsCall(7, 'dev:dogfood_substrate_status'));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    // The body must survive the peek unconsumed, exactly as the pg_query case asserts.
    expect(JSON.parse(await req.text()).params.name).toBe('dev:dogfood_substrate_status');
  });
  it('admits a bounded single-item work_items:get under critical pressure so a drain can inspect its claim', async () => {
    const req = post(toolsCall(8, 'work_items:get', { id: 'EI-22381211295936796' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:get');
  });
  it('admits a single work_items:checkpoint under critical pressure so recovery state can be persisted', async () => {
    const req = post(toolsCall(19, 'work_items:checkpoint', {
      id: 'WI-10000745',
      checkpoint: 'resume from this boundary',
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:checkpoint');
  });
  it('admits a deferred single work_items:checkpoint under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_checkpoint',
          args: { id: 'WI-10000745', checkpoint: 'resume from this boundary' },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds a bulk work_items:checkpoint under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(20, 'work_items:checkpoint', {
        items: [
          { id: 'WI-1', checkpoint: 'first' },
          { id: 'WI-2', checkpoint: 'second' },
        ],
      })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits tools:find under critical pressure so discovery can locate recovery tools', async () => {
    const req = post(toolsCall(8, 'tools:find', { query: 'grading integrity scorecard tools' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:find');
  });
  it('admits tools:find through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name: 'mcp__papercusp_su__tools_find', args: { query: 'grading integrity scorecard tools' } },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits an exact scorecard audit through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'scorecards:list',
            args: { rubricRef: 'grading-integrity', subjectRef: 'EI-22581128473264750', limit: 1 },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits one scorecard evidence read under critical pressure', async () => {
    const req = post(toolsCall(35, 'scorecards:get', { issueId: 'EI-22581128473264750' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('scorecards:get');
  });
  it('admits the bounded tool-failure capture under critical pressure', async () => {
    const req = post(
      toolsCall(36, 'improvements:capture', {
        toolFailure: { toolName: 'scorecards:get', message: 'operator MCP admission shed the read' },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('improvements:capture');
  });
  it('still sheds an authored improvements:capture under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(37, 'improvements:capture', { title: 'operator admission shed a grading audit call' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a single rubric read through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__rubrics_get',
            args: { rubricRef: 'goal-mode-e2e' },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds a bulk rubric read through tools:invoke under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: {
            name: 'tools:invoke',
            arguments: {
              name: 'rubrics:get',
              args: { rubricRefs: ['goal-mode-e2e', 'grading-integrity'] },
            },
          },
        }),
      ),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits the three bounded judge audit probes under critical pressure', async () => {
    for (const [name, args] of [
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 1 },
      ],
      ['gates:degenerate-check', { sinceHours: 24, minDecisions: 30 }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 }],
    ] as const) {
      const req = new Request(judgeRequestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: toolsCall(26, name, args),
      });
      expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    }
  });
  it('still sheds unbounded judge audit probes and bounded probes without judge role', async () => {
    const generic = await evaluateAdmission(
      post(
        toolsCall(27, 'plans:evaluate-spec-test-adequacy', {
          slug: 'adequacy-plan',
          classRef: 'plan-class-investigation',
          specIds: ['SPEC-001'],
        }),
      ),
      'critical',
      true,
    );
    expect(generic).not.toBeNull();
    const nonJudge = await evaluateAdmission(
      post(toolsCall(28, 'plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 })),
      'critical',
      true,
    );
    expect(nonJudge).not.toBeNull();
    expect((await nonJudge!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits bounded scratch capability:read through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__capability_read',
            args: {
              uri: 'papercusp://scratch/papercusp-workspace/result.spill',
              byte_offset: 0,
              byte_limit: 4096,
            },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds an unbounded work_items:get read under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(9, 'work_items:get', { ids: ['EI-1', 'EI-2'] })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('CONTROL: still sheds an unlisted dev tool under critical pressure with reason loop_pressure_critical', async () => {
    const shed = await evaluateAdmission(post(toolsCall(8, 'dev:pipeline_position')), 'critical', true);
    // Proves the admission above is the ALLOWLIST working, not critical-pressure shedding
    // having stopped working altogether — without this, the test above would still pass if the
    // gate were disabled entirely.
    expect(shed).not.toBeNull();
    expect(shed!.status).toBe(429);
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits (null) when the kill-switch disables admission control', async () => {
    expect(await evaluateAdmission(post(toolsCall()), 'critical', false)).toBeNull();
  });
  it('never sheds a GET (SSE reconnect / discovery), even critical', async () => {
    const get = new Request('http://127.0.0.1:3070/api/mcp', { method: 'GET' });
    expect(await evaluateAdmission(get, 'critical', true)).toBeNull();
  });
});
