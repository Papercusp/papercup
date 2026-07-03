import { describe, it, expect } from 'vitest';
import {
  pickNewSessionDir,
  sessionIdOf,
  sessionsSubtree,
  newestTranscript,
  scoreTranscriptLines,
  runBehaviourSuite,
  type RunnerDeps,
  type FoundFile,
} from './runner';
import type { BehaviourContext } from './assertions';

const ORNITH_CTX: BehaviourContext = { expectedModelSubstr: 'ornith', expectedWorkItemIds: ['WI-1', 'WI-2'] };

// A clean ornith transcript (same events assertions.test asserts pass on).
const CLEAN_LINES = [
  JSON.stringify({ type: 'model_change', model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'You have been handed this plan to implement. Read it with plans:get then present options.' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'x', name: 'mcp__papercusp_su_plans_get', arguments: JSON.stringify({ slug: 'p' }) }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'text', text: 'Options: (A) do it yourself, (B) hand to the Queen, or (C) launch a fleet. I recommend A. Confirm which route?' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'y', name: 'mcp__papercusp_su_work_items_claim', arguments: JSON.stringify({ ids: ['WI-1', 'WI-2'] }) }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'z', name: 'mcp__papercusp_su_work_items_complete', arguments: JSON.stringify({ items: [{ id: 'WI-1', completion: { summary: 'verified in sync, no drift' } }] }) }] } }),
].join('\n');

describe('behaviour-suite/runner — pure helpers', () => {
  it('pickNewSessionDir returns the newly-appeared session, greatest id wins', () => {
    expect(pickNewSessionDir(['session-9870'], ['session-9870', 'session-9871'])).toBe('session-9871');
    expect(pickNewSessionDir(['session-9870'], ['session-9870', 'session-9871', 'session-9873'])).toBe('session-9873');
    expect(pickNewSessionDir(['session-9870'], ['session-9870'])).toBeNull();
    // ignores non-session dirs
    expect(pickNewSessionDir([], ['tmp', 'session-5'])).toBe('session-5');
  });

  it('sessionIdOf strips the prefix; sessionsSubtree builds the agent/sessions path', () => {
    expect(sessionIdOf('session-9871')).toBe('9871');
    expect(sessionsSubtree('~/.papercusp/su-omp-homes', 'session-9871')).toBe('~/.papercusp/su-omp-homes/session-9871/agent/sessions');
    expect(sessionsSubtree('/root/', 'session-1')).toBe('/root/session-1/agent/sessions');
  });

  it('newestTranscript picks the highest mtime', async () => {
    const files: FoundFile[] = [
      { path: '/a/old.jsonl', mtimeMs: 100 },
      { path: '/a/new.jsonl', mtimeMs: 300 },
      { path: '/a/mid.jsonl', mtimeMs: 200 },
    ];
    const found = await newestTranscript('/a', { listFilesRec: () => files });
    expect(found?.path).toBe('/a/new.jsonl');
    expect(await newestTranscript('/a', { listFilesRec: () => [] })).toBeNull();
  });

  it('scoreTranscriptLines composes parse → checks → report (pass on a clean run)', () => {
    const report = scoreTranscriptLines(CLEAN_LINES.split('\n'), ORNITH_CTX, {}, 1_700_000_000_000);
    expect(report.verdict).toBe('pass');
    expect(report.meta.models?.[0]).toContain('ornith');
    expect(report.ranAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

/** A scripted fake: a virtual clock, a session dir that appears after `sessionAppearAt`,
 *  and a transcript file that is written at `transcriptAt` then stops growing. */
function makeFakeDeps(script: {
  sessionAppearAtMs: number;
  transcriptAtMs: number;
  transcriptStopsAtMs: number;
  lines: string;
  sessionDir?: string;
}): RunnerDeps & { launched: number; tornDown: number } {
  let clock = 0;
  let launched = 0;
  let tornDown = 0;
  const dir = script.sessionDir ?? 'session-9871';
  const tPath = `~/.papercusp/su-omp-homes/${dir}/agent/sessions/-cwd/2026_x.jsonl`;
  const state = { launched, tornDown };
  const deps: RunnerDeps & { launched: number; tornDown: number } = {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    launch: async () => { launched += 1; state.launched = launched; },
    teardown: async () => { tornDown += 1; state.tornDown = tornDown; },
    listDirs: () => (clock >= script.sessionAppearAtMs ? [dir] : []),
    listFilesRec: () => {
      if (clock < script.transcriptAtMs) return [];
      // mtime advances with the clock until it stops growing
      const mtime = Math.min(clock, script.transcriptStopsAtMs);
      return [{ path: tPath, mtimeMs: mtime }];
    },
    readFile: () => script.lines,
    get launched() { return state.launched; },
    get tornDown() { return state.tornDown; },
  } as RunnerDeps & { launched: number; tornDown: number };
  return deps;
}

describe('behaviour-suite/runner — full orchestration (fake launch + fake fs)', () => {
  const spec = { planSlug: 'fixture-p', model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M', agent: 'omp' };

  it('launches, waits for the session + settled transcript, scores it, tears down', async () => {
    const deps = makeFakeDeps({ sessionAppearAtMs: 6_000, transcriptAtMs: 12_000, transcriptStopsAtMs: 30_000, lines: CLEAN_LINES });
    const res = await runBehaviourSuite(
      { spec, ctx: ORNITH_CTX, settleMs: 9_000, pollMs: 3_000, maxWaitMs: 900_000 },
      deps,
    );
    expect(deps.launched).toBe(1);
    expect(deps.tornDown).toBe(1);
    expect(res.sessionId).toBe('9871');
    expect(res.captureOutcome).toBe('settled');
    expect(res.report.verdict).toBe('pass');
    expect(res.transcriptPath).toContain('.jsonl');
  });

  it('reports no-session when nothing new appears before the timeout', async () => {
    const deps = makeFakeDeps({ sessionAppearAtMs: 999_999_999, transcriptAtMs: 0, transcriptStopsAtMs: 0, lines: CLEAN_LINES });
    const res = await runBehaviourSuite(
      { spec, ctx: ORNITH_CTX, sessionAppearTimeoutMs: 30_000, pollMs: 5_000 },
      deps,
    );
    expect(res.captureOutcome).toBe('no-session');
    expect(res.sessionId).toBeNull();
    expect(res.report.verdict).toBe('fail'); // an empty transcript fails critical checks
    expect(deps.tornDown).toBe(1); // still tears down
  });

  it('reports no-transcript when the session dir appears but no jsonl is ever written', async () => {
    const deps = makeFakeDeps({ sessionAppearAtMs: 3_000, transcriptAtMs: 999_999_999, transcriptStopsAtMs: 0, lines: '' });
    const res = await runBehaviourSuite(
      { spec, ctx: ORNITH_CTX, sessionAppearTimeoutMs: 30_000, transcriptAppearTimeoutMs: 30_000, pollMs: 5_000 },
      deps,
    );
    expect(res.captureOutcome).toBe('no-transcript');
    expect(res.sessionId).toBe('9871');
    expect(res.transcriptPath).toBeNull();
  });
});
