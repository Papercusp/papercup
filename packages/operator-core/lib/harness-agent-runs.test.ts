/**
 * Coverage for harness-agent-runs.probeRunLiveness — decides whether an agent
 * run is still live from its run.jsonl: missing → not running, a tail
 * "type":"result" line → finished, otherwise running iff the mtime is within the
 * 10-min grace of `now`. Real temp files; `now` derived from the file's mtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRunLiveness } from './harness-agent-runs';

const GRACE = 10 * 60_000;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-runs-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeJsonl(name: string, content: string): { path: string; mtime: number } {
  const path = join(dir, name);
  writeFileSync(path, content);
  return { path, mtime: statSync(path).mtimeMs };
}

describe('probeRunLiveness', () => {
  it('reports not-running for a missing file', () => {
    expect(probeRunLiveness(join(dir, 'nope.jsonl'), Date.now())).toEqual({
      running: false,
      lastEventTs: 0,
    });
  });

  it('reports finished when the tail contains a result event', () => {
    const { path, mtime } = writeJsonl('done.jsonl', '{"type":"system"}\n{"type":"result","x":1}\n');
    // Even within the grace window, a result line means finished.
    expect(probeRunLiveness(path, mtime + 1000)).toEqual({ running: false, lastEventTs: mtime });
  });

  it('reports running when there is no result and the mtime is within grace', () => {
    const { path, mtime } = writeJsonl('live.jsonl', '{"type":"assistant"}\n');
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(true);
  });

  it('reports not-running when no result and the mtime is past grace (stale)', () => {
    const { path, mtime } = writeJsonl('stale.jsonl', '{"type":"assistant"}\n');
    expect(probeRunLiveness(path, mtime + GRACE + 1).running).toBe(false);
  });

  it('handles an empty file via the mtime grace', () => {
    const { path, mtime } = writeJsonl('empty.jsonl', '');
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(true);
    expect(probeRunLiveness(path, mtime + GRACE + 1).running).toBe(false);
  });
});

describe('probeRunLiveness — cross-backend terminal markers (cross-backend-cost-capture D-005)', () => {
  it('codex turn.completed is terminal', () => {
    const { path, mtime } = writeJsonl(
      'codex-done.jsonl',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n',
    );
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(false);
  });

  it('omp agent_end is terminal', () => {
    const { path, mtime } = writeJsonl(
      'omp-done.jsonl',
      '{"type":"message_end","message":{"role":"assistant"}}\n{"type":"agent_end","messages":[]}\n',
    );
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(false);
  });

  it('papercusp.run_meta stamp is terminal (authoritative exit marker)', () => {
    const { path, mtime } = writeJsonl(
      'meta-done.jsonl',
      '{"type":"assistant","text":"…"}\n{"type":"papercusp.run_meta","backend":"codex","model":"gpt-5.5","role":"worker"}\n',
    );
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(false);
  });

  it('omp message_end alone is NOT terminal (per-turn, run still live)', () => {
    const { path, mtime } = writeJsonl(
      'omp-mid.jsonl',
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":5,"output":1}}}\n',
    );
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(true);
  });
});

// ── scanAgentRuns — backend-aware usage parse over real log dirs ─────────────
import { mkdirSync } from 'node:fs';
import { scanAgentRuns } from './harness-agent-runs';
import type { ProjectEntry } from './harness-registry';

describe('scanAgentRuns — cross-backend usage + cost labeling', () => {
  let projRoot: string;
  let logDir: string;
  beforeAll(() => {
    projRoot = mkdtempSync(join(tmpdir(), 'agent-runs-scan-'));
    logDir = join(projRoot, '.papercusp', 'logs');
    mkdirSync(logDir, { recursive: true });
  });
  afterAll(() => rmSync(projRoot, { recursive: true, force: true }));

  const project = () => ({ slug: 'scan-test', path: projRoot }) as unknown as ProjectEntry;

  it('claude: provider cost + tokens + model from init; codex: estimated cost from run_meta model; omp: cost.total', () => {
    writeFileSync(join(logDir, '1700000000-worker.jsonl'), [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }),
      JSON.stringify({ type: 'result', result: 'DONE', total_cost_usd: 0.05, duration_ms: 1234, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 } }),
    ].join('\n') + '\n');
    writeFileSync(join(logDir, '1700000100-validator.jsonl'), [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }),
      JSON.stringify({ type: 'papercusp.run_meta', backend: 'codex', model: 'gpt-5.5', role: 'validator' }),
    ].join('\n') + '\n');
    writeFileSync(join(logDir, '1700000200-scoper.jsonl'), [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 10, output: 5, cost: { total: 0.003 } } } }),
      JSON.stringify({ type: 'agent_end', messages: [] }),
    ].join('\n') + '\n');

    const runs = scanAgentRuns(project());
    expect(runs).toHaveLength(3);
    const byRole = Object.fromEntries(runs.map((r) => [r.role, r]));

    // claude — provider-reported
    expect(byRole.worker.costUsd).toBeCloseTo(0.05, 9);
    expect(byRole.worker.costIsEstimate).toBe(false);
    expect(byRole.worker.inputTokens).toBe(100);
    expect(byRole.worker.cacheReadTokens).toBe(500);
    expect(byRole.worker.cacheCreationTokens).toBe(50);
    expect(byRole.worker.durationMs).toBe(1234);
    expect(byRole.worker.model).toBe('claude-opus-4-8');
    expect(byRole.worker.backend).toBe('claude-code');

    // codex — tokens only, priced from the run_meta model at list price + labeled
    expect(byRole.validator.inputTokens).toBe(1_000_000);
    expect(byRole.validator.outputTokens).toBe(100_000);
    expect(byRole.validator.costUsd).toBeCloseTo(4.5, 9); // 1M×$2.5 + 0.1M×$20 per MTok
    expect(byRole.validator.costIsEstimate).toBe(true);
    expect(byRole.validator.backend).toBe('codex');
    expect(byRole.validator.model).toBe('gpt-5.5');

    // omp — provider-reported cost.total
    expect(byRole.scoper.costUsd).toBeCloseTo(0.003, 9);
    expect(byRole.scoper.costIsEstimate).toBe(false);
    expect(byRole.scoper.backend).toBe('omp');
    expect(byRole.scoper.running).toBe(false); // agent_end terminal
  });
});
