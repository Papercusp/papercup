import { describe, expect, it } from 'vitest';
import {
  buildTraceSpec,
  buildTrialRequest,
  budgetAdmits,
  CLAUDE_CODE_IDENTITY,
  D058_BUDGET,
  inputCostUsd,
  isRetryable,
  parseMessagesSse,
  projectTrace,
  runTrace,
  STRATUM_GAP_MS,
  summarizeTrial,
  type TrialArm,
  type TrialRequestBody,
  type TrialRequestRow,
  type TrialSend,
  type TrialStratum,
  weightedPercentile,
} from './ttl-cadence-trial';

const MODEL = 'claude-opus-5-5';

function spec(pairId: string, stratum: TrialStratum, nonce: string, seed = 7, requests = 4) {
  return buildTraceSpec({ pairId, stratum, nonce, model: MODEL, seed, systemWords: 400, chunkWords: 120, requests });
}

/**
 * Loopback Anthropic-like provider on a virtual clock. Omitted TTLs are upgraded to 1h (the
 * deployed gateway policy); explicit TTLs are kept. Cache entries live per prefix (nonce + block
 * index) with expiry refreshed on read; tokens are whitespace words.
 */
let n = 0; // message ids are unique across every fake provider instance, like the real source
/**
 * Stream faults observed live on 2026-09-26 (P-007): `cut` ends after message_start (no stop,
 * no output), `overloaded` sends an in-stream error event after HTTP 200, `thinking` answers with
 * a thinking block only (output tokens spent, no text).
 */
type StreamFault = 'cut' | 'overloaded' | 'thinking' | null;
function fakeProvider(clock: { t: number }, fault: (call: number) => StreamFault = () => null) {
  let calls = 0;
  const entries = new Map<string, { expiresAt: number; ttlMs: number }>();
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const send: TrialSend = async (body: TrialRequestBody) => {
    const blocks: { tokens: number; ttl?: '5m' | '1h'; marked: boolean }[] = [];
    const push = (text: string, cc?: { type: 'ephemeral'; ttl?: '5m' | '1h' }) =>
      blocks.push({ tokens: words(text), marked: !!cc, ttl: cc ? (cc.ttl ?? '1h') : undefined });
    for (const b of body.system) push(b.text, b.cache_control);
    for (const m of body.messages) for (const b of m.content) push(b.text, b.cache_control);
    const nonce = body.system[body.system.length - 1].text.split('\n')[0];
    const key = (i: number) => `${nonce}#${i}`;
    const lastMarker = blocks.map((b, i) => (b.marked ? i : -1)).filter((i) => i >= 0).pop()!;
    let readTo = -1;
    for (let i = lastMarker; i >= 0; i--) {
      const e = entries.get(key(i));
      if (e && e.expiresAt > clock.t) { readTo = i; e.expiresAt = clock.t + e.ttlMs; break; }
    }
    const sum = (from: number, to: number) => blocks.slice(from, to + 1).reduce((a, b) => a + b.tokens, 0);
    const read = readTo >= 0 ? sum(0, readTo) : 0;
    let w5 = 0, w1 = 0, cursor = readTo + 1;
    for (let i = readTo + 1; i <= lastMarker; i++) {
      if (!blocks[i].marked) continue;
      const toks = sum(cursor, i);
      const ttlMs = blocks[i].ttl === '5m' ? 300_000 : 3_600_000;
      if (blocks[i].ttl === '5m') w5 += toks; else w1 += toks;
      entries.set(key(i), { expiresAt: clock.t + ttlMs, ttlMs });
      cursor = i + 1;
    }
    const uncached = sum(lastMarker + 1, blocks.length - 1);
    const lastUser = body.messages[body.messages.length - 1].content[0].text;
    const code = /code word for this section is (\S+?)\./.exec(lastUser)?.[1] ?? '';
    n++;
    const f = fault(++calls);
    const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
    const start = ev({ type: 'message_start', message: { id: `msg_${n}`, usage: { input_tokens: uncached, cache_read_input_tokens: read,
      cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: 0 } } });
    const block = f === 'thinking'
      ? ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })
      : ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: code } });
    const end = ev({ type: 'content_block_stop', index: 0 }) +
      ev({ type: 'message_delta', delta: { stop_reason: f === 'thinking' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: f === 'thinking' ? 32 : 5 } }) +
      ev({ type: 'message_stop' });
    const raw = f === 'cut' ? start
      : f === 'overloaded' ? start + ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
      : start + block + end;
    // Processing time grows with the tokens the provider had to (re)process, like a real miss.
    const ttftMs = 200 + (uncached + w5 + w1) / 2;
    return { httpStatus: 200, body: raw, ttftMs, totalMs: ttftMs + 50, headers: { routedAccount: 'acct-1', gatewayRequestId: `gw_${n}` } };
  };
  return send;
}

async function runPair(pairId: string, stratum: TrialStratum, seed: number, requests = 4) {
  const rows: TrialRequestRow[] = [];
  for (const arm of ['control', 'candidate'] as TrialArm[]) {
    const clock = { t: 0 };
    const send = fakeProvider(clock);
    await runTrace(spec(pairId, stratum, `${pairId}-${arm}`, seed, requests), arm, STRATUM_GAP_MS[stratum], {
      send,
      sleep: async (ms) => { clock.t += ms; },
      now: () => new Date(clock.t),
      onRow: (r) => { rows.push(r); },
    });
  }
  return rows;
}

describe('buildTrialRequest', () => {
  const s = spec('p1', 'A', 'n1');
  it('control omits ttl; candidate states 1h on system then 5m on the last user message', () => {
    const c = buildTrialRequest(s, 'control', 2, ['r0', 'r1']);
    const k = buildTrialRequest(s, 'candidate', 2, ['r0', 'r1']);
    // The subscription-transport identity leads, unmarked, in both arms.
    expect(c.system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTITY });
    expect(k.system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTITY });
    expect(c.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(k.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const markers = (b: TrialRequestBody) => b.messages.flatMap((m) => m.content).filter((x) => x.cache_control);
    expect(markers(c)).toHaveLength(1);
    expect(markers(c)[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(markers(k)[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(k.messages[k.messages.length - 1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(k.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(k.messages[1].content[0].text).toBe('r0');
  });
  it('keeps both arms byte-identical apart from the markers', () => {
    const strip = (b: TrialRequestBody) => JSON.stringify(b, (key, v) => (key === 'cache_control' ? undefined : v));
    expect(strip(buildTrialRequest(s, 'control', 1, ['r0']))).toBe(strip(buildTrialRequest(s, 'candidate', 1, ['r0'])));
  });
  it('refuses a request without the prior replies it needs', () => {
    expect(() => buildTrialRequest(s, 'control', 2, ['r0'])).toThrow(/prior replies/);
  });
});

describe('parseMessagesSse + inputCostUsd', () => {
  it('reads source-reported tiers and prices them at the model rates', () => {
    const raw = [
      `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_a', usage: { input_tokens: 10, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 3_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 } } } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}`,
    ].join('\n');
    const p = parseMessagesSse(raw);
    expect(p.messageId).toBe('msg_a');
    expect(p.text).toBe('hi');
    expect(p.usage.outputTokens).toBe(3);
    // opus-5-5: in $4/M, read $0.2/M, 5m write 1.25x, 1h write 2x.
    expect(inputCostUsd(MODEL, p.usage)).toBeCloseTo(10 * 4e-6 + 0.2 + 5 + 16, 6);
  });
  it('returns null (never a guessed tier) when a tier is not reported', () => {
    const p = parseMessagesSse(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 5 } } })}`);
    expect(inputCostUsd(MODEL, p.usage)).toBeNull();
  });
});

describe('runTrace + summarizeTrial against the loopback provider', () => {
  it('prices the mixed tail cheaper inside 5m and dearer past 5m, and retains 1h when the weighted CI does not win', async () => {
    const rows: TrialRequestRow[] = [];
    let seed = 11;
    for (const s of ['A', 'B', 'C'] as TrialStratum[]) for (let i = 0; i < 3; i++) rows.push(...(await runPair(`${s}${i}`, s, seed++)));
    const sum = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 0.3, B: 0.5, C: 0.2 } });
    expect(sum.requests).toMatchObject({ attempts: 72, ok: 72, errors: 0, coverage: 1 });
    expect(sum.uniqueChargedIds.duplicates).toEqual([]);
    expect(sum.byStratum.A!.delta.upper).toBeLessThan(0);
    expect(sum.byStratum.B!.delta.lower).toBeGreaterThan(0);
    expect(sum.byStratum.C!.delta.lower).toBeGreaterThan(0);
    // The candidate's tail writes are 5m; the control never writes 5m (omitted -> 1h).
    expect(sum.byStratum.A!.tierMix.control.write5m).toBe(0);
    expect(sum.byStratum.A!.tierMix.candidate.write5m).toBeGreaterThan(0);
    expect(sum.quality).toEqual({ control: 1, candidate: 1, regression: false });
    expect(sum.decision.adoptCandidate).toBe(false);
    expect(sum.decision.reasons.join(' ')).toMatch(/upper bound/);
  });

  it('weights reduce to the single stratum when all weight is on it', async () => {
    const rows: TrialRequestRow[] = [];
    let seed = 40;
    for (const s of ['A', 'B', 'C'] as TrialStratum[]) for (let i = 0; i < 2; i++) rows.push(...(await runPair(`${s}${i}`, s, seed++)));
    const sum = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 1, B: 0, C: 0 } });
    expect(sum.weighted!.point).toBeCloseTo(sum.byStratum.A!.delta.point, 10);
    expect(sum.weighted!.upper).toBeLessThan(0);
    expect(sum.decision.adoptCandidate).toBe(true);
  });

  it('weights latency by the gap mix, so rare long-gap misses do not stand in for the population', async () => {
    const rows: TrialRequestRow[] = [];
    let seed = 60;
    for (const s of ['A', 'B', 'C'] as TrialStratum[]) for (let i = 0; i < 2; i++) rows.push(...(await runPair(`${s}${i}`, s, seed++)));
    const even = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 1, B: 1, C: 1 } });
    const prod = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 0.9965, B: 0.0013, C: 0.0017 } });
    // The candidate re-processes its expired tail in B/C, so it is slower there.
    expect(even.latencyByStratum.B!.candidateP95!).toBeGreaterThan(even.latencyByStratum.B!.controlP95!);
    expect(even.latency.ratio!).toBeGreaterThan(prod.latency.ratio!);
    expect(prod.latency.ratio!).toBeLessThanOrEqual(1.1);
  });

  it('retries capacity refusals, keeps every attempt, and pairs on the final attempt', async () => {
    const rows: TrialRequestRow[] = [];
    const clock = { t: 0 };
    const ok = fakeProvider(clock);
    let calls = 0;
    const busy: TrialSend = async (b, ctx) => (++calls === 2 ? { httpStatus: 429, body: '{"error":"rate_limit_error"}', ttftMs: null, totalMs: 40_000, headers: { routedAccount: null, gatewayRequestId: null } } : ok(b, ctx));
    const deps = { sleep: async (ms: number) => { clock.t += ms; }, now: () => new Date(clock.t), onRow: (r: TrialRequestRow) => { rows.push(r); }, maxAttempts: 3, retryDelayMs: () => 10_000 };
    await runTrace(spec('R', 'A', 'r-c'), 'control', 30_000, { ...deps, send: ok });
    await runTrace(spec('R', 'A', 'r-k'), 'candidate', 30_000, { ...deps, send: busy });
    const cand = rows.filter((r) => r.arm === 'candidate');
    expect(cand).toHaveLength(5);
    expect(cand.filter((r) => r.status === 'error').map((r) => [r.seq, r.attempt])).toEqual([[1, 1]]);
    expect(cand.find((r) => r.seq === 1 && r.attempt === 2)?.status).toBe('ok');
    const sum = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 1, B: 1, C: 1 } });
    expect(sum.excludedPairs).toEqual([]);
    expect(sum.requests).toMatchObject({ attempts: 9, ok: 8, errors: 1, coverage: 1 });
    expect(sum.decision.reasons.join(' ')).not.toMatch(/coverage/);
  });

  it('never retries a non-capacity rejection such as an unsupported marker', async () => {
    const rows: TrialRequestRow[] = [];
    const reject: TrialSend = async () => ({ httpStatus: 400, body: '{"error":"cache_control ttl not supported"}', ttftMs: null, totalMs: 5, headers: { routedAccount: 'a', gatewayRequestId: 'g' } });
    await runTrace(spec('Z', 'A', 'z-k'), 'candidate', 30_000, { send: reject, sleep: async () => {}, now: () => new Date(0), onRow: (r) => { rows.push(r); }, maxAttempts: 3 });
    expect(rows).toHaveLength(1);
    expect(isRetryable(rows[0])).toBe(false);
  });

  it('weightedPercentile ignores zero-weight values and honours weights', () => {
    expect(weightedPercentile([{ value: 1, weight: 1 }, { value: 100, weight: 0 }], 95)).toBe(1);
    expect(weightedPercentile([{ value: 1, weight: 0.9 }, { value: 50, weight: 0.1 }], 95)).toBe(50);
    expect(weightedPercentile([{ value: 1, weight: 0.96 }, { value: 50, weight: 0.04 }], 95)).toBe(1);
    expect(weightedPercentile([], 95)).toBeNull();
  });

  it('flags a reused charged request id instead of counting it twice', async () => {
    const rows = await runPair('D0', 'A', 90);
    rows.push({ ...rows[0], pairId: 'D1' });
    const sum = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 1, B: 1, C: 1 } });
    expect(sum.uniqueChargedIds.duplicates).toEqual([rows[0].messageId]);
    expect(sum.decision.reasons.join(' ')).toMatch(/duplicate charged request id/);
  });

  it('stops a trace on a failed request, retains the row and excludes the pair', async () => {
    const rows: TrialRequestRow[] = [];
    const clock = { t: 0 };
    const ok = fakeProvider(clock);
    let calls = 0;
    const flaky: TrialSend = async (b, ctx) => (++calls === 2 ? { httpStatus: 400, body: '{"error":"unsupported ttl"}', ttftMs: null, totalMs: 5, headers: { routedAccount: 'acct-1', gatewayRequestId: 'gw_x' } } : ok(b, ctx));
    const deps = { sleep: async (ms: number) => { clock.t += ms; }, now: () => new Date(clock.t), onRow: (r: TrialRequestRow) => { rows.push(r); } };
    await runTrace(spec('X', 'A', 'x-c'), 'control', 30_000, { ...deps, send: ok });
    await runTrace(spec('X', 'A', 'x-k'), 'candidate', 30_000, { ...deps, send: flaky });
    expect(rows.filter((r) => r.arm === 'candidate')).toHaveLength(2);
    expect(rows.find((r) => r.status === 'error')?.error).toMatch(/unsupported ttl/);
    const sum = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 1, B: 1, C: 1 } });
    expect(sum.excludedPairs.map((p) => p.pairId)).toEqual(['X']);
    expect(sum.requests.errors).toBe(1);
    expect(sum.decision.adoptCandidate).toBe(false);
  });
});

describe('stream outcome: cut streams, in-stream errors and text-less replies', () => {
  const deps = (clock: { t: number }, rows: TrialRequestRow[]) => ({
    sleep: async (ms: number) => { clock.t += ms; }, now: () => new Date(clock.t), onRow: (r: TrialRequestRow) => { rows.push(r); },
  });

  it('parses the stop reason, block types and message_stop; an in-stream error is never complete', () => {
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}`;
    const start = ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 0 } } });
    const whole = [start, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 32 } }), ev({ type: 'message_stop' })].join('\n');
    expect(parseMessagesSse(whole)).toMatchObject({ text: '', stopReason: 'max_tokens', contentBlockTypes: ['thinking'], streamError: null, complete: true });
    expect(parseMessagesSse(start)).toMatchObject({ complete: false, streamError: null, messageId: 'm1' });
    const errored = [start, ev({ type: 'error', error: { type: 'overloaded_error' } }), ev({ type: 'message_stop' })].join('\n');
    expect(parseMessagesSse(errored)).toMatchObject({ complete: false, streamError: 'overloaded_error' });
  });

  it('records a cut stream as a retried error that keeps its usage, never as an empty answer', async () => {
    const rows: TrialRequestRow[] = [];
    const clock = { t: 0 };
    const send = fakeProvider(clock, (call) => (call === 2 ? 'cut' : null));
    await runTrace(spec('S', 'A', 's-c'), 'control', 30_000, { ...deps(clock, rows), send, maxAttempts: 3, retryDelayMs: () => 1_000 });
    const cut = rows.find((r) => r.seq === 1 && r.attempt === 1)!;
    expect(cut).toMatchObject({ status: 'error', httpStatus: 200, error: 'stream incomplete: no message_stop', stopReason: null });
    expect(cut.usage?.inputTokens).not.toBeNull();
    expect(isRetryable(cut)).toBe(true);
    expect(rows.filter((r) => r.status === 'ok').map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(rows.every((r) => r.status !== 'ok' || r.qualityOk)).toBe(true);
  });

  it('retries an overloaded in-stream error but ends the trace on any other in-stream error', async () => {
    const rows: TrialRequestRow[] = [];
    const clock = { t: 0 };
    await runTrace(spec('O', 'A', 'o-c'), 'control', 30_000, { ...deps(clock, rows), send: fakeProvider(clock, (c) => (c === 1 ? 'overloaded' : null)), maxAttempts: 2, retryDelayMs: () => 1 });
    expect(rows[0]).toMatchObject({ status: 'error', streamError: 'overloaded_error' });
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(4);
    const bad = { ...rows[0], streamError: 'invalid_request_error' };
    expect(isRetryable(bad)).toBe(false);
  });

  it('discloses text-less replies and the traces that continued after one, without changing the decision inputs', async () => {
    const rows: TrialRequestRow[] = [];
    const clock = { t: 0 };
    await runTrace(spec('T', 'A', 't-c'), 'control', 30_000, { ...deps(clock, rows), send: fakeProvider(clock, (c) => (c >= 2 ? 'thinking' : null)) });
    const k = { t: 0 };
    await runTrace(spec('T', 'A', 't-k'), 'candidate', 30_000, { ...deps(k, rows), send: fakeProvider(k) });
    const sum = summarizeTrial(rows, { requestsPerTrace: 4, weights: { A: 1, B: 1, C: 1 } });
    // The registered quality measure is untouched: 1 of 4 control answers matched.
    expect(sum.quality).toEqual({ control: 0.25, candidate: 1, regression: false });
    expect(sum.anomalies.emptyRepliesByArm).toEqual({ control: 3, candidate: 0 });
    expect(sum.anomalies.emptyReplies[0]).toMatchObject({ pairId: 'T', arm: 'control', seq: 1, outputTokens: 32, stopReason: 'max_tokens', contentBlockTypes: ['thinking'], causeRecorded: true });
    expect(sum.anomalies.cascadedTraces).toEqual([{ pairId: 'T', arm: 'control', fromSeq: 1, laterRequests: 2, laterEmpty: 2 }]);
    // Up to and including the first empty reply: control 1 of 2.
    expect(sum.anomalies.qualityBeforeCascade).toEqual({ control: 0.5, candidate: 1 });
  });

  it('marks the cause unknown on rows written before the runner recorded stream outcome', async () => {
    const rows = await runPair('L', 'A', 5);
    const legacy = rows.map((r) => (r.arm === 'control' && r.seq === 2
      ? { ...r, replyText: '', qualityOk: false, stopReason: undefined, contentBlockTypes: undefined, streamError: undefined } : r));
    const sum = summarizeTrial(legacy, { requestsPerTrace: 4, weights: { A: 1, B: 1, C: 1 } });
    expect(sum.anomalies.emptyReplies).toEqual([{ pairId: 'L', arm: 'control', seq: 2, outputTokens: 5, stopReason: null, contentBlockTypes: null, causeRecorded: false }]);
    expect(sum.anomalies.cascadedTraces).toEqual([{ pairId: 'L', arm: 'control', fromSeq: 2, laterRequests: 1, laterEmpty: 0 }]);
  });
});

describe('budget projection (D-058 caps)', () => {
  it('projects conservatively and refuses the trace that would cross a cap', () => {
    const s = buildTraceSpec({ pairId: 'p', stratum: 'C', nonce: 'n', model: MODEL, seed: 3, systemWords: 12_000, chunkWords: 3_000, requests: 6 });
    const proj = projectTrace(s, 2, { inPerM: 4, outPerM: 20 });
    expect(proj.chargedRequests).toBe(6);
    expect(proj.inputTokens).toBeGreaterThan(6 * 12_000 * 2);
    expect(budgetAdmits({ chargedRequests: 0, inputTokens: 0, outputTokens: 0, usd: 0 }, proj, D058_BUDGET).ok).toBe(true);
    const nearCap = { chargedRequests: 0, inputTokens: D058_BUDGET.maxInputTokens - 1, outputTokens: 0, usd: 0 };
    expect(budgetAdmits(nearCap, proj, D058_BUDGET)).toEqual({ ok: false, axis: 'maxInputTokens' });
    expect(budgetAdmits({ chargedRequests: 328, inputTokens: 0, outputTokens: 0, usd: 0 }, proj, D058_BUDGET).axis).toBe('maxChargedRequests');
  });
});
