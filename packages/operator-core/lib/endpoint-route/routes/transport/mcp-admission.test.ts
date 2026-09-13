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
  isBoundedDevTelemetryArgs,
  isBoundedCoordPresenceArgs,
  isBoundedCoordRosterArgs,
  isBoundedEventsStatusArgs,
  isBoundedLoopArmArgs,
  isBoundedLocksQueueArgs,
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
    'coord:whoami',
    'coord_whoami',
    'mcp__papercusp-su__coord_whoami',
    'mcp__papercusp_su__coord_whoami',
  ])('does NOT shed no-args coord:whoami under critical pressure: %s', async (name) => {
    const body = toolsCall(14, name, {});
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
    expect(await evaluateAdmission(post(body), 'critical', true)).toBeNull();
  });

  it('admits omitted coord:whoami arguments but keeps non-empty arguments sheddable', () => {
    const omitted = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'coord:whoami' },
    });
    expect(classifyMcpBody(omitted)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(omitted)).toBe('diagnostic');

    for (const args of [{ ownerId: 'su-target' }, { unexpected: true }, null]) {
      const body = toolsCall(16, 'coord:whoami', args as Record<string, unknown>);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 16 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('admits no-args coord:whoami through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__coord_whoami', args: {} },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
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
    'locks:queue',
    'locks_queue',
    'mcp__papercusp-su__locks_queue',
    'mcp__papercusp_su__locks_queue',
  ])('does NOT shed a bounded locks:queue ownership read under critical pressure: %s', (name) => {
    const args = { paths: ['packages/operator-core/lib/release/frozen-repair-edit-ledger.ts'] };
    const body = toolsCall(12, name, args);
    expect(isBoundedLocksQueueArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad locks:queue reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { paths: [] },
      { external_paths: [] },
      { paths: ['packages/operator-core/lib/release/frozen-repair-edit-ledger.ts'], include_completed: true },
      { paths: [''] },
    ]) {
      expect(isBoundedLocksQueueArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(13, 'locks:queue', args))).toEqual({ sheddable: true, id: 13 });
    }
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

  it.each([
    ['owner', { owner: 'su-target' }],
    ['ownerId', { ownerId: 'su-target' }],
    ['owners', { owners: ['su-target', 'su-peer'] }],
    ['ownerIds', { ownerIds: ['su-target', 'su-peer'] }],
  ])('admits bounded targeted coord:presence selector %s under critical pressure', (_label, args) => {
    const body = toolsCall(31, 'coord:presence', args);
    expect(isBoundedCoordPresenceArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits targeted coord:presence aliases through tools:invoke and rejects broad/project-only reads', () => {
    const deferred = JSON.stringify({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__coord_presence', args: { ownerIds: ['su-target'] } },
      },
    });
    expect(classifyMcpBody(deferred)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(deferred)).toBe('diagnostic');
    for (const args of [{}, { project: 'ids' }, { owner: 'su-target', owners: ['su-peer'] }, { owners: [] }]) {
      expect(isBoundedCoordPresenceArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(33, 'coord:presence', args))).toEqual({ sheddable: true, id: 33 });
    }
  });

  it.each([
    ['default live', { owner: 'su-target' }],
    ['live', { view: 'live', owner: 'su-target' }],
    ['members', { view: 'members', owner: 'su-target' }],
  ])('admits bounded targeted coord:roster %s under critical pressure', (_label, args) => {
    const body = toolsCall(34, 'coord:roster', args);
    expect(isBoundedCoordRosterArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits targeted coord:roster through tools:invoke but preserves broad/project-only shedding', () => {
    const deferred = JSON.stringify({
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__coord_roster', args: { view: 'members', owner: 'su-target' } },
      },
    });
    expect(classifyMcpBody(deferred)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(deferred)).toBe('diagnostic');
    for (const args of [{ view: 'live' }, { view: 'live', project: 'ids' }, { view: 'claims', owner: 'su-target' }, { owner: '' }]) {
      expect(isBoundedCoordRosterArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(36, 'coord:roster', args))).toEqual({ sheddable: true, id: 36 });
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
    ['canonical', 'scheduler:get_next'],
    ['underscore', 'scheduler_get_next'],
    ['mcp-advertised', 'mcp__papercusp_su__scheduler_get_next'],
  ])('does NOT shed a bounded scheduler self-pull under critical pressure: %s', (_label, name) => {
    const body = toolsCall(14, name, {
      harness: 'papercusp',
      heldPaths: [],
      states: ['open'],
      rigAvailable: false,
      ignoreContextPressure: false,
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or malformed scheduler self-pulls sheddable under critical pressure', () => {
    for (const args of [
      { harness: 'papercusp', unknown: true },
      { harness: '', states: ['open'] },
      { harness: 'papercusp', states: ['blocked'] },
      { harness: 'papercusp', heldPaths: Array.from({ length: 501 }, () => 'path') },
      { harness: 'papercusp', heldPaths: ['x'.repeat(513)] },
      { harness: 'papercusp', rigAvailable: 'false' },
    ]) {
      expect(classifyMcpBody(toolsCall(15, 'scheduler:get_next', args))).toEqual({
        sheddable: true,
        id: 15,
      });
    }
  });

  it('recognizes a bounded scheduler self-pull through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scheduler_get_next',
          args: { harness: 'papercusp', heldPaths: [], states: ['failing'] },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'loop:status'],
    ['underscore', 'loop_status'],
    ['mcp-advertised', 'mcp__papercusp_su__loop_status'],
  ])('does NOT shed a bounded loop status read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(17, name, { harness: 'papercusp', ownerId: 'self' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('still sheds an opaque loop status payload under critical pressure', () => {
    expect(
      classifyMcpBody(toolsCall(18, 'loop:status', { unexpected: 'unbounded' })),
    ).toEqual({ sheddable: true, id: 18 });
  });

  it('recognizes a bounded loop status read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_status',
          args: { owner: 'self' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'loop:arm'],
    ['underscore', 'loop_arm'],
    ['mcp-advertised', 'mcp__papercusp_su__loop_arm'],
  ])('does NOT shed a bounded short work loop arm under critical pressure: %s', (_label, name) => {
    const args = { intervalSec: 60, goal: 'resume the current fleet work item', carry: 'cold', mode: 'work' };
    expect(isBoundedLoopArmArgs(args)).toBe(true);
    const body = toolsCall(20, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes a bounded loop arm through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_arm',
          args: {
            intervalSec: 60,
            goal: 'resume the current fleet work item',
            workItem: 'EI-23122062573237933',
            carry: 'cold',
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps unbounded or non-work loop arms sheddable under critical pressure', () => {
    for (const args of [
      { intervalSec: 60, goal: 'resume the current fleet work item', wakePrompt: 'custom wake' },
      { intervalSec: 60, goal: 'resume the current fleet work item', mode: 'monitor' },
      { intervalSec: 60, goal: 'resume the current fleet work item', continuation: 'gated' },
      { intervalSec: 60, goal: 'x'.repeat(501) },
      { intervalSec: 60, goal: 'resume the current fleet work item', blockedOn: { reason: 'peer' } },
      { intervalSec: 60, goal: 'resume the current fleet work item', ownerId: 'su-peer' },
    ]) {
      expect(isBoundedLoopArmArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(22, 'loop:arm', args))).toEqual({ sheddable: true, id: 22 });
      expect(classifyMcpRequest(toolsCall(22, 'loop:arm', args))).toBe('ordinary');
    }
  });

  it.each([
    ['canonical', 'events:status'],
    ['underscore', 'events_status'],
    ['mcp-advertised', 'mcp__papercusp_su__events_status'],
  ])('does NOT shed an exact events status await read under critical pressure: %s', (_label, name) => {
    const args = { await_id: 178337 };
    expect(isBoundedEventsStatusArgs(args)).toBe(true);
    const body = toolsCall(24, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'events:status'],
    ['underscore', 'events_status'],
    ['mcp-advertised', 'mcp__papercusp_su__events_status'],
  ])('does NOT shed an exact events status event read under critical pressure: %s', (_label, name) => {
    const args = { event: 'work-item:done:EI-23109903341283549', after_generation: 7 };
    expect(isBoundedEventsStatusArgs(args)).toBe(true);
    const body = toolsCall(25, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes an exact events status read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__events_status',
          args: { event: 'work-item:done:EI-23109903341283549' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad, metered, mixed, and malformed events status reads sheddable', () => {
    for (const args of [
      {},
      { meter: false },
      { meter: true, await_id: 178337 },
      { await_id: 0 },
      { await_id: 1.5 },
      { await_id: '178337' },
      { await_id: 178337, event: 'work-item:done:EI-1' },
      { await_id: 178337, after_generation: 7 },
      { after_generation: 7 },
      { event: '' },
      { event: '   ' },
      { event: 'x'.repeat(201) },
      { event: 'work-item:done:EI-1', after_generation: -1 },
      { event: 'work-item:done:EI-1', after_generation: 1.5 },
      { event: 'work-item:done:EI-1', unexpected: true },
    ]) {
      expect(isBoundedEventsStatusArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(27, 'events:status', args))).toEqual({
        sheddable: true,
        id: 27,
      });
    }
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
    ['canonical', 'coord:send'],
    ['underscore', 'coord_send'],
    ['mcp-advertised', 'mcp__papercusp_su__coord_send'],
  ])('admits one bounded direct coord:send under critical pressure: %s', (_label, name) => {
    const body = toolsCall(40, name, {
      to: ['su-peer'],
      summary: 'critical-pressure correction recorded',
      expects: 'none',
      body: [{ text: 'The durable correction is recorded; retry the detailed write after recovery.' }],
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one bounded coord:send through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__coord_send',
          args: {
            to: ['su-peer'],
            summary: 'critical-pressure correction recorded',
            expects: 'none',
            body: [{ text: 'The durable correction is recorded.' }],
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or enriched coord:send writes sheddable under critical pressure', () => {
    for (const args of [
      {
        to: ['*'],
        summary: 'broadcast',
        expects: 'none',
      },
      {
        to: ['@fleet:nonp2p-bug-drain-luna-max-50'],
        summary: 'audience',
        expects: 'none',
      },
      {
        to: ['su-peer', 'su-other'],
        summary: 'multiple recipients',
        expects: 'none',
      },
      {
        to: ['su-peer'],
        summary: 'wake',
        expects: 'none',
        wake: 'required',
      },
      {
        to: ['su-peer'],
        summary: 'missing action body',
        expects: 'action',
      },
      {
        to: ['su-peer'],
        summary: 'enriched',
        expects: 'none',
        body: [{ text: 'status', premises: ['EI-1'] }],
      },
      {
        to: ['su-peer'],
        summary: 'x'.repeat(601),
        expects: 'none',
      },
    ]) {
      expect(classifyMcpBody(toolsCall(42, 'coord:send', args))).toEqual({ sheddable: true, id: 42 });
    }
  });

  it('keeps enriched coord:send and aliased work_items:comment sheddable through tools:invoke', () => {
    for (const [name, args] of [
      [
        'mcp__papercusp_su__coord_send',
        { to: ['su-peer'], summary: 'wake', expects: 'none', wake: 'required' },
      ],
      ['mcp__papercusp_su__work_items_comment', { id: 'EI-1', comment: 'alias' }],
    ] as const) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 46,
        method: 'tools/call',
        params: { name: 'tools:invoke', arguments: { name, args } },
      });
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 46 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    ['canonical', 'work_items:comment'],
    ['underscore', 'work_items_comment'],
    ['mcp-advertised', 'mcp__papercusp_su__work_items_comment'],
  ])('admits one bounded direct work_items:comment under critical pressure: %s', (_label, name) => {
    const body = toolsCall(43, name, { id: 'EI-23122407516371253', body: 'Correction recorded.' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one bounded work_items:comment batch through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 44,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_comment',
          args: { items: [{ id: 'EI-23122407516371253', body: 'Correction recorded.' }] },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps bulk, aliases, and enriched work_items:comment writes sheddable under critical pressure', () => {
    for (const args of [
      { id: 'EI-1', comment: 'alias' },
      { id: 'EI-1', body: 'inline', harness: 'papercusp' },
      { items: [{ id: 'EI-1', body: 'one' }, { id: 'EI-2', body: 'two' }] },
      { items: [{ id: 'EI-1', comment: 'alias' }] },
      { id: 'EI-1', body: 'x'.repeat(601) },
    ]) {
      expect(classifyMcpBody(toolsCall(45, 'work_items:comment', args))).toEqual({ sheddable: true, id: 45 });
    }
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
    ['canonical', 'scorecards:evaluate'],
    ['underscore', 'scorecards_evaluate'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_evaluate'],
  ])('does NOT shed a skeleton scorecards:evaluate read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(16, name, { rubricRef: 'spec-test-adequacy' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes an empty-ratings scorecards:evaluate skeleton through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_evaluate',
          args: { rubricRef: 'spec-test-adequacy', ratings: {} },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps completed or opaque scorecards:evaluate payloads sheddable under critical pressure', () => {
    for (const args of [
      { rubricRef: 'spec-test-adequacy', ratings: { criterion: { rating: 'pass', evidence: 'evidence' } } },
      { rubricRef: 'spec-test-adequacy', instrumentSnapshots: {} },
      { rubricRef: 'spec-test-adequacy', testedSha: '01a80572c224' },
      { rubricRef: 'spec-test-adequacy', unknown: true },
    ]) {
      expect(classifyMcpBody(toolsCall(18, 'scorecards:evaluate', args))).toEqual({ sheddable: true, id: 18 });
    }
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

  it('does NOT shed generated scorecard evidence pages under critical pressure', () => {
    for (const args of [
      { issueId: 'EI-22581128473264750', criterionKey: 'freshness' },
      { issueId: 'EI-22581128473264750', criterionKey: 'freshness', evidenceOffset: 1600 },
    ]) {
      const body = toolsCall(29, 'scorecards:get', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body)).toBe('diagnostic');
    }
  });

  it('keeps ambiguous or oversized scorecards:get reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { id: 'EI-22581128473264750' },
      { issueId: ' ' },
      { issueId: 'x'.repeat(121) },
      { issueId: 'EI-1', extra: true },
      { issueId: 'EI-1', evidenceOffset: 1600 },
      { issueId: 'EI-1', criterionKey: 'freshness', evidenceOffset: -1 },
    ]) {
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

  it('recognizes a paginated scorecard evidence read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_get',
          args: { issueId: 'EI-22581128473264750', criterionKey: 'freshness', evidenceOffset: 1600 },
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

  it('admits the generated exact evaluator replay shape at the critical-pressure boundary', () => {
    const body = toolsCall(23, 'plans:evaluate-spec-test-adequacy', {
      harness: 'papercusp',
      slug: 'adequacy-plan',
      classRef: 'plan-class-investigation',
      evaluatorBuild: { sha: 'sha256:evaluator', version: '0.0.0' },
      specIds: ['SPEC-001'],
      evidenceRefs: ['test-run:42'],
      includeDraft: true,
      limit: 25,
      specRevision: 1,
      specFingerprint: 'sha256:spec',
      replaySnapshot: true,
      current: [],
    });
    expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('diagnostic');
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

  it('sheds the unbounded outer code:run wrapper while reserving a direct bounded scorecard probe', async () => {
    // code:run has a bounded script/foreground timeout, but its script may loop, branch, and
    // dispatch an unbounded number of nested tools during that window. The pressure gate must
    // classify that outer orchestration as ordinary even when its script happens to contain a
    // bounded-looking scorecards:get call; only the direct bounded probe gets the recovery lane.
    const outerBody = toolsCall(29, 'code:run', {
      script: [
        "const first = await tools.scorecards.get({ issueId: 'EI-22581128473264750' });",
        'for (const issueId of inputs.issueIds) await tools.scorecards.get({ issueId });',
        'return { found: Boolean(first), scanned: inputs.issueIds.length };',
      ].join('\n'),
      timeoutSec: 30,
    });
    expect(classifyMcpBody(outerBody, judgeRequestUrl)).toEqual({ sheddable: true, id: 29 });
    expect(classifyMcpRequest(outerBody, judgeRequestUrl)).toBe('ordinary');

    const shed = await evaluateAdmission(
      new Request(judgeRequestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: outerBody,
      }),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });

    const direct = await evaluateAdmission(
      new Request(judgeRequestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: toolsCall(30, 'scorecards:get', { issueId: 'EI-22581128473264750' }),
      }),
      'critical',
      true,
    );
    expect(direct).toBeNull();
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
  it('admits a bounded dev:telemetry rollup under critical pressure so recovery diagnostics stay live', async () => {
    const req = post(toolsCall(24, 'dev:telemetry', { hours: 24, limit: 50 }));
    expect(isBoundedDevTelemetryArgs({ hours: 24, limit: 50 })).toBe(true);
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('dev:telemetry');
  });
  it('keeps broad dev:telemetry queries shed under critical pressure', async () => {
    for (const args of [
      { hours: 24, limit: 51 },
      { hours: 25, limit: 50 },
      { limit: 50, unexpected: true },
      { hours: 24, limit: 50, workspaceIds: Array.from({ length: 33 }, (_, i) => `ws-${i}`) },
    ]) {
      expect(isBoundedDevTelemetryArgs(args)).toBe(false);
      const shed = await evaluateAdmission(post(toolsCall(25, 'dev:telemetry', args)), 'critical', true);
      expect(shed).not.toBeNull();
      expect((await shed!.json()).error.data).toMatchObject({
        retryable: true,
        reason: 'loop_pressure_critical',
      });
    }
  });
  it('admits bounded dev:telemetry through tools:invoke under critical pressure', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__dev_telemetry',
          args: { hours: 24, limit: 50 },
        },
      },
    });
    expect(await evaluateAdmission(post(body), 'critical', true)).toBeNull();
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
  it('admits a bounded locks:queue ownership read under critical pressure so recovery can inspect held files', async () => {
    const req = post(
      toolsCall(14, 'locks:queue', {
        paths: [
          'packages/operator-core/lib/release/frozen-repair-edit-ledger.ts',
          'packages/operator-core/lib/release/frozen-repair-edit-ledger.test.ts',
        ],
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('locks:queue');
  });
  it('still sheds an unfiltered locks:queue read under critical pressure', async () => {
    const shed = await evaluateAdmission(post(toolsCall(15, 'locks:queue')), 'critical', true);
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded single-item work_items:get under critical pressure so a drain can inspect its claim', async () => {
    const req = post(toolsCall(8, 'work_items:get', { id: 'EI-22381211295936796' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:get');
  });
  it('admits a bounded scheduler self-pull under critical pressure for direct staging calls', async () => {
    const req = post(toolsCall(17, 'scheduler:get_next', {
      harness: 'papercusp',
      heldPaths: [],
      states: ['open'],
      rigAvailable: false,
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('scheduler:get_next');
  });
  it('admits a bounded loop status read under critical pressure for resumed reconciliation', async () => {
    const req = post(toolsCall(22, 'loop:status', { ownerId: 'self' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('loop:status');
  });
  it('admits a bounded loop arm under critical pressure so a cold wake can restore its cadence', async () => {
    const req = post(toolsCall(23, 'loop:arm', {
      intervalSec: 60,
      goal: 'resume the current fleet work item',
      workItem: 'EI-23122062573237933',
      carry: 'cold',
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('loop:arm');
  });
  it('admits a deferred bounded loop arm under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_arm',
          args: {
            intervalSec: 60,
            goal: 'resume the current fleet work item',
            workItem: null,
            carry: 'cold',
          },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds an unbounded loop arm under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(25, 'loop:arm', {
        intervalSec: 60,
        goal: 'resume the current fleet work item',
        wakePrompt: 'custom wake',
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

  it.each([
    ['await id', { await_id: 178337 }],
    ['exact event', { event: 'work-item:done:EI-23109903341283549', after_generation: 7 }],
  ])('admits bounded events:status %s under critical pressure', async (_label, args) => {
    const req = post(toolsCall(28, 'events:status', args));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('events:status');
  });

  it('admits deferred bounded events:status under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 29,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__events_status',
          args: { await_id: 178337 },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });

  it('still sheds a loop status read with an unknown argument under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(23, 'loop:status', { unknown: true })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds a broad events:status read under critical pressure', async () => {
    const shed = await evaluateAdmission(post(toolsCall(30, 'events:status', {})), 'critical', true);
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds an unbounded scheduler self-pull under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(18, 'scheduler:get_next', { harness: 'papercusp', extra: 'unbounded' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
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
