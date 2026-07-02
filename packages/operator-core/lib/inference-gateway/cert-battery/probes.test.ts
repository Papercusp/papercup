import { describe, expect, it } from 'vitest';
import {
  behaviorProbe,
  classifyFirstToolCall,
  commsProbe,
  manglingRateProbe,
  parseToolArgs,
  trimmedShapeProbe,
} from './probes';
import type { ChatRequest, ChatResult, ProbeContext } from './types';

// --- fake clients ---------------------------------------------------------

function ctxFrom(chat: (req: ChatRequest) => ChatResult): ProbeContext {
  return { now: () => 0, chat: async (r) => chat(r) };
}
const offered = (r: ChatRequest) => (r.tools ?? []).map((t) => t.function.name);
function call(name: string, args: unknown): ChatResult {
  return {
    text: '',
    toolCalls: [{ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }],
    stopReason: 'tool_calls',
  };
}
const text = (s: string): ChatResult => ({ text: s, toolCalls: [], stopReason: 'stop' });

/** A healthy model: exact JSON for behavior, valid tool calls echoing the required args/token. */
const good = ctxFrom((r) => {
  const names = offered(r);
  if (names.includes('emit_finding')) return call('emit_finding', { summary: 's', count: 7 });
  if (names.includes('handoff')) return call('handoff', { token: 'ORN-7F3A', note: 'go' });
  if (names.includes('consume')) return call('consume', { token: 'ORN-7F3A' });
  return text('{"count":3,"first":"alpha"}');
});

describe('parseToolArgs', () => {
  it('parses a JSON object', () => expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 }));
  it('parses a fenced object (eval-battery tryParseJson recovery)', () =>
    expect(parseToolArgs('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it('returns null for unparseable args (a mangled emission)', () => expect(parseToolArgs('not json')).toBeNull());
  it('returns null for a JSON array (not an args object)', () => expect(parseToolArgs('[1,2]')).toBeNull());
});

describe('classifyFirstToolCall', () => {
  it('flags no emission', () => {
    const c = classifyFirstToolCall(text('hi'), ['emit_finding']);
    expect(c).toMatchObject({ emitted: false, malformed: false, notFound: false });
  });
  it('flags a not-found tool name', () => {
    const c = classifyFirstToolCall(call('nope', { x: 1 }), ['emit_finding']);
    expect(c).toMatchObject({ emitted: true, notFound: true, malformed: false });
  });
  it('flags malformed args', () => {
    const c = classifyFirstToolCall(call('emit_finding', 'garbage'), ['emit_finding']);
    expect(c).toMatchObject({ emitted: true, notFound: false, malformed: true, args: null });
  });
});

describe('behaviorProbe', () => {
  it('passes when the model returns the exact bounded JSON shape', async () => {
    const r = await behaviorProbe(good);
    expect(r.passed).toBe(true);
    expect(r.critical).toBe(true);
    expect(r.metrics).toMatchObject({ countCorrect: true, firstCorrect: true, boundedOutput: true });
  });
  it('fails on drift (long rambling non-JSON reply)', async () => {
    const drift = ctxFrom(() => text('Sure! '.repeat(60)));
    const r = await behaviorProbe(drift);
    expect(r.passed).toBe(false);
    expect(r.metrics.parsedJson).toBe(false);
  });
  it('fails when the count is wrong', async () => {
    const wrong = ctxFrom(() => text('{"count":2,"first":"alpha"}'));
    const r = await behaviorProbe(wrong);
    expect(r.passed).toBe(false);
    expect(r.metrics.countCorrect).toBe(false);
  });
});

describe('trimmedShapeProbe', () => {
  it('passes on a valid emit_finding call and records a clean tool-call stat', async () => {
    const r = await trimmedShapeProbe(good);
    expect(r.passed).toBe(true);
    expect(r.toolCallStats).toEqual({ attempts: 1, malformed: 0, notFound: 0 });
  });
  it('fails + counts a malformed emission', async () => {
    const bad = ctxFrom(() => call('emit_finding', 'not-json'));
    const r = await trimmedShapeProbe(bad);
    expect(r.passed).toBe(false);
    expect(r.toolCallStats).toEqual({ attempts: 1, malformed: 1, notFound: 0 });
  });
  it('fails + counts a not-found tool name', async () => {
    const bad = ctxFrom(() => call('emit_findings', { summary: 's', count: 7 }));
    const r = await trimmedShapeProbe(bad);
    expect(r.passed).toBe(false);
    expect(r.toolCallStats).toEqual({ attempts: 1, malformed: 0, notFound: 1 });
  });
  it('fails with zero attempts when the model narrates instead of emitting a tool call', async () => {
    const narrate = ctxFrom(() => text('I would call emit_finding(summary="x", count=7)'));
    const r = await trimmedShapeProbe(narrate);
    expect(r.passed).toBe(false);
    expect(r.metrics.emittedToolCall).toBe(false);
    expect(r.toolCallStats).toEqual({ attempts: 0, malformed: 0, notFound: 0 });
  });
  it('fails when required fields are missing (count omitted)', async () => {
    const partial = ctxFrom(() => call('emit_finding', { summary: 'only' }));
    const r = await trimmedShapeProbe(partial);
    expect(r.passed).toBe(false);
    expect(r.metrics.requiredFieldsPresent).toBe(false);
    // still a well-formed JSON emission — not a mangle
    expect(r.toolCallStats).toEqual({ attempts: 1, malformed: 0, notFound: 0 });
  });
});

describe('commsProbe', () => {
  it('passes when producer hands off a token the consumer echoes', async () => {
    const r = await commsProbe(good);
    expect(r.passed).toBe(true);
    expect(r.metrics.roundTripOk).toBe(true);
    expect(r.toolCallStats).toEqual({ attempts: 2, malformed: 0, notFound: 0 });
  });
  it('fails when the consumer echoes the wrong token', async () => {
    const badConsumer = ctxFrom((req) => {
      const names = offered(req);
      if (names.includes('handoff')) return call('handoff', { token: 'ORN-7F3A', note: 'go' });
      return call('consume', { token: 'WRONG' });
    });
    const r = await commsProbe(badConsumer);
    expect(r.passed).toBe(false);
    expect(r.metrics.consumerEchoedToken).toBe(false);
    expect(r.metrics.producerTokenCorrect).toBe(true);
  });
  it('fails when the producer never emits a handoff', async () => {
    const badProducer = ctxFrom((req) => {
      const names = offered(req);
      if (names.includes('handoff')) return text('handing off now...');
      return call('consume', { token: 'ORN-7F3A' });
    });
    const r = await commsProbe(badProducer);
    expect(r.passed).toBe(false);
    expect(r.metrics.producerEmittedHandoff).toBe(false);
  });
});

describe('manglingRateProbe', () => {
  it('is 0 and passes for a clean model', async () => {
    const r = await manglingRateProbe(good, 4);
    expect(r.metrics).toMatchObject({ reps: 4, emissions: 4, malformed: 0, notFound: 0, rate: 0 });
    expect(r.passed).toBe(true);
    expect(r.critical).toBe(false);
  });
  it('is 1 and fails when every emission is malformed JSON', async () => {
    const storm = ctxFrom(() => call('emit_finding', '{oops not json'));
    const r = await manglingRateProbe(storm, 4);
    expect(r.metrics.rate).toBe(1);
    expect(r.passed).toBe(false);
    expect(r.toolCallStats).toEqual({ attempts: 4, malformed: 4, notFound: 0 });
  });
  it('counts no-emit reps out of the denominator (rate over emissions only)', async () => {
    const r = await manglingRateProbe(ctxFrom(() => text('no tool')), 4);
    expect(r.metrics).toMatchObject({ reps: 4, emissions: 0, noEmit: 4, rate: 0 });
    // no emissions → the mangling gate is not what catches this model (the critical probes are)
    expect(r.passed).toBe(true);
  });
});
