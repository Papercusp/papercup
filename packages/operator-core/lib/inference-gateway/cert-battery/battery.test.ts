import { describe, expect, it } from 'vitest';
import { aggregateMangling, computeVerdict, runCertBattery } from './battery';
import type { CertConfig, ChatRequest, ChatResult, ProbeContext, ProbeResult } from './types';

function pr(over: Partial<ProbeResult> & Pick<ProbeResult, 'probe'>): ProbeResult {
  return { passed: true, critical: true, detail: '', metrics: {}, ...over };
}

const CONFIG: CertConfig = { model: 'ornith-35b', quant: 'IQ3_M', numCtx: 180224, parallel: 2, backend: 'llama-server' };

describe('aggregateMangling', () => {
  it('sums tool-call stats across probes and computes the rate over emissions', () => {
    const { rate, detail } = aggregateMangling([
      pr({ probe: 'trimmed-shape', toolCallStats: { attempts: 1, malformed: 0, notFound: 0 } }),
      pr({ probe: 'comms', toolCallStats: { attempts: 2, malformed: 1, notFound: 0 } }),
      pr({ probe: 'mangling-rate', critical: false, toolCallStats: { attempts: 5, malformed: 0, notFound: 1 } }),
      pr({ probe: 'behavior' }), // no toolCallStats — ignored
    ]);
    expect(detail).toEqual({ attempts: 8, malformed: 1, notFound: 1 });
    expect(rate).toBeCloseTo(2 / 8);
  });
  it('is 0 with no tool attempts (never divides by zero)', () => {
    expect(aggregateMangling([pr({ probe: 'behavior' })])).toEqual({ rate: 0, detail: { attempts: 0, malformed: 0, notFound: 0 } });
  });
});

describe('computeVerdict', () => {
  const criticals = [pr({ probe: 'behavior' }), pr({ probe: 'trimmed-shape' }), pr({ probe: 'comms' })];
  it('certifies when every critical passes and mangling is within threshold', () => {
    expect(computeVerdict(criticals, 0.1)).toBe('certified');
  });
  it('fails when a critical probe fails, regardless of mangling', () => {
    expect(computeVerdict([...criticals.slice(1), pr({ probe: 'behavior', passed: false })], 0)).toBe('failed');
  });
  it('fails when mangling exceeds the threshold even if criticals pass', () => {
    expect(computeVerdict(criticals, 0.5)).toBe('failed');
  });
  it('ignores a failing NON-critical probe for the pass gate (mangling folds in via the rate)', () => {
    expect(computeVerdict([...criticals, pr({ probe: 'mangling-rate', critical: false, passed: false })], 0.1)).toBe('certified');
  });
});

// --- runner over a fake client -------------------------------------------

function ctxFrom(chat: (req: ChatRequest) => ChatResult): ProbeContext {
  return { now: () => 0, chat: async (r) => chat(r) };
}
const offered = (r: ChatRequest) => (r.tools ?? []).map((t) => t.function.name);
function call(name: string, args: unknown): ChatResult {
  return { text: '', toolCalls: [{ function: { name, arguments: JSON.stringify(args) } }], stopReason: 'tool_calls' };
}
const good = ctxFrom((r) => {
  const names = offered(r);
  if (names.includes('emit_finding')) return call('emit_finding', { summary: 's', count: 7 });
  if (names.includes('handoff')) return call('handoff', { token: 'ORN-7F3A', note: 'go' });
  if (names.includes('consume')) return call('consume', { token: 'ORN-7F3A' });
  return { text: '{"count":3,"first":"alpha"}', toolCalls: [], stopReason: 'stop' };
});

describe('runCertBattery', () => {
  it('certifies a healthy model across all four probes', async () => {
    const report = await runCertBattery(CONFIG, { ctx: good });
    expect(report.verdict).toBe('certified');
    expect(report.probes.map((p) => p.probe)).toEqual(['behavior', 'trimmed-shape', 'comms', 'mangling-rate']);
    expect(report.manglingRate).toBe(0);
    expect(report.config).toEqual(CONFIG);
    expect(report.ranAt).toBe(new Date(0).toISOString());
    expect(report.summary).toContain('[certified]');
    expect(report.summary).toContain('2×90112 ctx'); // 180224 / 2 slots
  });

  it('fails a model that narrates instead of emitting tool calls', async () => {
    const narrate = ctxFrom(() => ({ text: 'I would call the tool', toolCalls: [], stopReason: 'stop' }));
    const report = await runCertBattery(CONFIG, { ctx: narrate });
    expect(report.verdict).toBe('failed');
    // behavior fails (not JSON), trimmed-shape + comms fail (no emission); mangling has no emissions
    expect(report.probes.find((p) => p.probe === 'trimmed-shape')?.passed).toBe(false);
    expect(report.manglingRate).toBe(0);
  });

  it('honors a probes override (subset run)', async () => {
    const { behaviorProbe } = await import('./probes');
    const report = await runCertBattery(CONFIG, { ctx: good, probes: [behaviorProbe] });
    expect(report.probes).toHaveLength(1);
    expect(report.probes[0].probe).toBe('behavior');
    expect(report.verdict).toBe('certified');
  });
});
