/**
 * spawn-hydration unit tests — the P-021 assembler is pure + DI-seamed, so it
 * tests with fake source deps and no DB (directed-wake-honesty-2026-06-14 P-021/P-013).
 */
import { describe, it, expect } from 'vitest';
import { assembleSpawnHydration, type SpawnHandoffContext, type HandoffEntry } from './spawn-hydration';

function entry(o: Partial<HandoffEntry> & { body: string; ts: number }): HandoffEntry {
  return { kind: o.kind ?? 'message', origin: o.origin ?? 'local', trusted: o.trusted ?? true, ...o };
}

describe('assembleSpawnHydration', () => {
  it('returns empty text when no source is provided (caller omits the section)', async () => {
    const r = await assembleSpawnHydration({ harness: 'h' });
    expect(r.text).toBe('');
    expect(r.dropped).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('composes all sources under one ## Handoff block in priority order', async () => {
    const handoff: SpawnHandoffContext = {
      messages: [entry({ body: 'note A', ts: 2, fromFeatureId: 'F-1' })],
      predecessorSummaries: [entry({ kind: 'completion', body: 'F-0 done: built X', ts: 1 })],
      planSlice: '### Current State\nbuild the thing',
      truncated: false,
    };
    const r = await assembleSpawnHydration({
      harness: 'h',
      featureId: 'F-2',
      planSlug: 'p',
      workItemId: 'WI-1',
      deps: {
        getHandoff: async () => handoff,
        getRoster: async () => 'bee-1 (worker, idle 30s)',
        getCheckpoint: async () => 'half-done: wired the store',
      },
    });
    expect(r.text.startsWith('## Handoff')).toBe(true);
    // Priority: carry-note ▸ upstream completions ▸ plan slice ▸ messages ▸ roster.
    const idxCarry = r.text.indexOf('Carry-note');
    const idxUpstream = r.text.indexOf('Upstream completions');
    const idxMsgs = r.text.indexOf('Handoff messages');
    const idxRoster = r.text.indexOf('Hive peers');
    expect(idxCarry).toBeGreaterThanOrEqual(0);
    expect(idxCarry).toBeLessThan(idxUpstream);
    expect(idxUpstream).toBeLessThan(idxMsgs);
    expect(idxMsgs).toBeLessThan(idxRoster);
    expect(r.text).toContain('half-done: wired the store');
    expect(r.text).toContain('F-0 done: built X');
    expect(r.text).toContain('(F-1) note A');
    expect(r.text).toContain('bee-1 (worker, idle 30s)');
  });

  it('is fail-soft: a throwing source degrades only its section', async () => {
    const r = await assembleSpawnHydration({
      harness: 'h',
      workItemId: 'WI-1',
      deps: {
        getHandoff: async () => {
          throw new Error('boom');
        },
        getCheckpoint: async () => 'carry note survives',
      },
    });
    expect(r.text).toContain('carry note survives');
    expect(r.text).not.toContain('Upstream completions');
  });

  it('skips the checkpoint source entirely when no workItemId is given', async () => {
    let called = false;
    const r = await assembleSpawnHydration({
      harness: 'h',
      deps: {
        getCheckpoint: async () => {
          called = true;
          return 'x';
        },
      },
    });
    expect(called).toBe(false);
    expect(r.text).toBe('');
  });

  it('bounds by DROPPING WHOLE handoff entries — never severs an untrusted frame (P-013)', async () => {
    const framed = (n: number): HandoffEntry =>
      entry({
        kind: 'completion',
        origin: 'remote',
        trusted: false,
        ts: n,
        body: `<untrusted-peer-content author="x">remote summary ${n} ${'.'.repeat(60)}</untrusted-peer-content>`,
      });
    const handoff: SpawnHandoffContext = {
      messages: [],
      predecessorSummaries: [framed(1), framed(2), framed(3)],
      planSlice: null,
      truncated: false,
    };
    const logs: string[] = [];
    const r = await assembleSpawnHydration({
      harness: 'h',
      maxChars: 160,
      log: (m) => logs.push(m),
      deps: { getHandoff: async () => handoff },
    });
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.truncated).toBe(true);
    // Every untrusted frame that survived is intact — opens === closes, never a half-frame.
    const opens = (r.text.match(/<untrusted-peer-content/g) ?? []).length;
    const closes = (r.text.match(/<\/untrusted-peer-content>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(logs.some((l) => /drop/i.test(l))).toBe(true);
  });

  it('truncates a RAW (trusted, unframed) plan slice at its boundary with a marker', async () => {
    const handoff: SpawnHandoffContext = {
      messages: [],
      predecessorSummaries: [],
      planSlice: 'P'.repeat(500),
      truncated: false,
    };
    const r = await assembleSpawnHydration({
      harness: 'h',
      maxChars: 120,
      deps: { getHandoff: async () => handoff },
    });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('…[truncated]');
  });

  it('propagates the gather\'s own truncated flag even when nothing is dropped at assembly', async () => {
    const handoff: SpawnHandoffContext = {
      messages: [entry({ body: 'short', ts: 1 })],
      predecessorSummaries: [],
      planSlice: null,
      truncated: true, // the gather already capped at its source
    };
    const r = await assembleSpawnHydration({ harness: 'h', deps: { getHandoff: async () => handoff } });
    expect(r.truncated).toBe(true);
    expect(r.dropped).toBe(0);
  });
});
