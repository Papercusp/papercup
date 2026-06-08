/**
 * bee-trace.test.ts — the P-002 transcript→signals reader (Apiary gen-0).
 *
 * Pure unit coverage: fixture JSONL + injected loaders, zero PG / FS / spend. Proves the two
 * outputs the battery threads — the judge's distilled trace and the collectors' REAL signals —
 * are derived faithfully from a finished bee, including the failure / escalation / fallback edges.
 * (`locateBeeTranscript`'s on-disk glob is exercised against a temp dir.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTranscriptLines,
  sumTranscriptTokens,
  extractAssistantText,
  locateBeeTranscript,
  collectAndDistillFromBee,
  makeBeeCollectAndDistill,
  type BeeSpawnRow,
} from './bee-trace';
import type { InstanceRunHandle } from './instance-manifest';
import type { CorpusCase } from './corpus';

/** A claude-code transcript: a header line, two assistant turns (one with tool_use), a user line. */
const TRANSCRIPT = [
  JSON.stringify({ type: 'summary', sessionId: 's1', content: 'header', timestamp: 1 }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First I read the failing test.' },
        { type: 'tool_use', name: 'Read', input: { path: 'x.ts' } },
      ],
      usage: { input_tokens: 100, output_tokens: 40 },
    },
  }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Fixed the off-by-one. Done.' }],
      usage: { input_tokens: 30, output_tokens: 60 },
    },
  }),
  '', // a trailing blank line (normal)
  '{ this is not valid json', // a partially-flushed last line (normal)
].join('\n');

function spawn(over: Partial<BeeSpawnRow> = {}): BeeSpawnRow {
  return {
    status: 'done',
    runId: 'r-bee-1',
    startedAt: new Date('2026-06-08T00:00:00Z'),
    finishedAt: new Date('2026-06-08T00:02:30Z'), // +150s → time-to-green
    durationMs: 150_000,
    outputTail: 'last lines of stdout',
    errorMessage: null,
    ...over,
  };
}

describe('bee-trace — pure parsing', () => {
  it('parseTranscriptLines skips blank + malformed lines', () => {
    const lines = parseTranscriptLines(TRANSCRIPT);
    // header + 2 assistant + 1 user = 4 valid (blank + bad-json dropped)
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.type)).toEqual(['summary', 'assistant', 'user', 'assistant']);
  });

  it('sumTranscriptTokens sums ONLY assistant usage', () => {
    const t = sumTranscriptTokens(parseTranscriptLines(TRANSCRIPT));
    expect(t.inputTokens).toBe(130); // 100 + 30
    expect(t.outputTokens).toBe(100); // 40 + 60
  });

  it('extractAssistantText pulls text blocks + tool_use markers, drops user', () => {
    const text = extractAssistantText(parseTranscriptLines(TRANSCRIPT));
    expect(text).toContain('First I read the failing test.');
    expect(text).toContain('[tool_use: Read]');
    expect(text).toContain('Fixed the off-by-one. Done.');
    expect(text).not.toContain('tool_result'); // user line dropped
  });
});

describe('bee-trace — locateBeeTranscript', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'bee-trace-'));
    const proj = join(base, 's-bee-x', 'projects', '-some-slug');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'old.jsonl'), '{}');
    writeFileSync(join(proj, 'new.jsonl'), '{}');
    writeFileSync(join(proj, 'notes.txt'), 'ignore me');
    // Make new.jsonl strictly newer than old.jsonl.
    utimesSync(join(proj, 'old.jsonl'), new Date(1000), new Date(1000));
    utimesSync(join(proj, 'new.jsonl'), new Date(9000), new Date(9000));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('returns the newest .jsonl under the per-spawn dir', () => {
    const p = locateBeeTranscript('s-bee-x', base);
    expect(p).toMatch(/new\.jsonl$/);
  });

  it('returns null when the spawn left no transcript dir', () => {
    expect(locateBeeTranscript('s-nope', base)).toBeNull();
  });
});

describe('bee-trace — collectAndDistillFromBee (signal mapping)', () => {
  it('a solved bee → done status, real tokens, time-to-green window, not escalated', () => {
    const r = collectAndDistillFromBee({
      spawnId: 's-bee-1',
      spawn: spawn(),
      transcriptText: TRANSCRIPT,
      runTokens: { inputTokens: 5000, outputTokens: 1200 }, // PG totals win over transcript sum
      maxChars: 4000,
    });
    expect(r.signals.workItemStatus).toBe('done');
    expect(r.signals.inputTokens).toBe(5000);
    expect(r.signals.outputTokens).toBe(1200);
    expect(r.signals.workItemAttempts).toBe(1);
    expect(r.signals.escalated).toBe(false);
    expect(r.signals.workItemCreatedAt).toEqual(new Date('2026-06-08T00:00:00Z'));
    expect(r.signals.workItemResolvedAt).toEqual(new Date('2026-06-08T00:02:30Z'));
    expect(r.traceRef).toBe('bee:s-bee-1');
    expect(r.distilledTrace).toContain('Fixed the off-by-one');
    expect(r.distilledTrace).toContain('## Terminal state');
  });

  it('falls back to transcript token sum when no PG totals landed', () => {
    const r = collectAndDistillFromBee({
      spawnId: 's-bee-1',
      spawn: spawn(),
      transcriptText: TRANSCRIPT,
      runTokens: null,
      maxChars: 4000,
    });
    expect(r.signals.inputTokens).toBe(130);
    expect(r.signals.outputTokens).toBe(100);
  });

  it('a failed bee → non-done status (the collector will read it as not-success)', () => {
    const r = collectAndDistillFromBee({
      spawnId: 's-bee-2',
      spawn: spawn({ status: 'failed', errorMessage: 'boot timeout', finishedAt: null }),
      transcriptText: TRANSCRIPT,
      runTokens: { inputTokens: 10, outputTokens: 10 },
      maxChars: 4000,
    });
    expect(r.signals.workItemStatus).toBe('failed');
    expect(r.rawSignals.exitError).toBe('boot timeout');
    // No finishedAt → no time-to-green window.
    expect(r.signals.workItemResolvedAt).toBeUndefined();
  });

  it('detects the ESCALATE verb in output_tail', () => {
    const r = collectAndDistillFromBee({
      spawnId: 's-bee-3',
      spawn: spawn({ outputTail: 'stuck on missing creds — ESCALATE to keeper' }),
      transcriptText: TRANSCRIPT,
      runTokens: { inputTokens: 10, outputTokens: 10 },
      maxChars: 4000,
    });
    expect(r.signals.escalated).toBe(true);
  });

  it('no transcript → falls back to output_tail for the judge trace', () => {
    const r = collectAndDistillFromBee({
      spawnId: 's-bee-4',
      spawn: spawn({ outputTail: 'only the tail survived' }),
      transcriptText: null,
      runTokens: { inputTokens: 10, outputTokens: 10 },
      maxChars: 4000,
    });
    expect(r.distilledTrace).toContain('only the tail survived');
    expect(r.distilledTrace).toContain('bee(output_tail)');
  });

  it('respects the maxChars budget (distillTrace caps the trace)', () => {
    const huge = 'x'.repeat(50_000);
    const r = collectAndDistillFromBee({
      spawnId: 's-bee-5',
      spawn: spawn({ outputTail: huge }),
      transcriptText: null,
      runTokens: { inputTokens: 1, outputTokens: 1 },
      maxChars: 500,
    });
    expect(r.distilledTrace.length).toBeLessThanOrEqual(500);
  });
});

describe('bee-trace — makeBeeCollectAndDistill (injected loaders)', () => {
  const handle: InstanceRunHandle = { instanceId: 's-bee-1', instanceUrl: 'mock://x', costUsd: 0.01 };
  const corpusCase = { id: 'c1', variant: 'fix-injected-bug', title: 't', prompt: 'p' } as unknown as CorpusCase;

  it('loads spawn + tokens + transcript and distills', async () => {
    const effect = makeBeeCollectAndDistill({
      loadSpawn: async () => spawn(),
      loadRunTokens: async (runId) => {
        expect(runId).toBe('r-bee-1');
        return { inputTokens: 7000, outputTokens: 900 };
      },
      loadTranscript: () => TRANSCRIPT,
    });
    const r = await effect({ handle, case: corpusCase, maxChars: 4000 });
    expect(r.signals.inputTokens).toBe(7000);
    expect(r.signals.workItemStatus).toBe('done');
    expect(r.distilledTrace).toContain('Fixed the off-by-one');
  });

  it('a missing spawn row degrades to an errored-shaped trace (battery continues)', async () => {
    const effect = makeBeeCollectAndDistill({
      loadSpawn: async () => null,
      loadRunTokens: async () => null,
      loadTranscript: () => null,
    });
    const r = await effect({ handle, case: corpusCase, maxChars: 4000 });
    expect(r.signals.workItemStatus).toBe('missing');
    expect(r.distilledTrace).toContain('No spawn row recorded');
  });
});
