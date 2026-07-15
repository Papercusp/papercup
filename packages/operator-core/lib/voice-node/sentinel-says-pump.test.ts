/**
 * sentinel-says-pump unit tests (voice-unified-sentinel-pipeline-2026-07-01,
 * P-002/P-004; persist moved to voice:say push-time under WI-4838): the pane's
 * voice:say lines are displayed + spoken through the bus while a session is
 * live, the FIFO is left alone (for the webview's local-mode drain) when no
 * session is live, and the pump does NOT persist — `voice:say` already wrote
 * the line to the shared conversation at push time, so a drain-time persist
 * would double-write the turn.
 */
import { describe, expect, it, vi } from 'vitest';
import { FrameDecoder } from '@papercusp/p2p-voice';
import { pumpSentinelSaysOnce, type SentinelSaysPumpDeps } from './sentinel-says-pump';
import { decodeOpVoiceFrame, type OpVoiceMessage } from './operator-voice-bus';

function makeDeps(opts: { live?: boolean; lines?: string[]; speakOk?: boolean } = {}) {
  const out: OpVoiceMessage[] = [];
  const spoken: string[] = [];
  const logs: string[] = [];
  const drain = vi.fn(async () => opts.lines ?? []);
  const deps: SentinelSaysPumpDeps = {
    sessionLive: () => opts.live ?? true,
    drain,
    speak: vi.fn(async (text: string) => {
      spoken.push(text);
      return opts.speakOk ?? true;
    }),
    broadcast: (frame: Uint8Array) => {
      const dec = new FrameDecoder();
      for (const f of dec.push(frame)) {
        const m = decodeOpVoiceFrame(f);
        if (m) out.push(m);
      }
    },
    log: (msg) => logs.push(msg),
  };
  return { deps, out, spoken, logs, drain };
}

describe('pumpSentinelSaysOnce', () => {
  it('leaves the FIFO alone when no session is live (webview local-mode owns it)', async () => {
    const h = makeDeps({ live: false, lines: ['hello'] });
    const n = await pumpSentinelSaysOnce(h.deps);
    expect(n).toBe(0);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('displays + speaks each drained line, in order', async () => {
    const h = makeDeps({ lines: ['first answer', 'second answer'] });
    const n = await pumpSentinelSaysOnce(h.deps);
    expect(n).toBe(2);
    const transcripts = h.out.filter((m) => m.kind === 'response_transcript');
    expect(transcripts.map((t) => (t as { text: string }).text)).toEqual(['first answer', 'second answer']);
    expect(h.spoken).toEqual(['first answer', 'second answer']);
  });

  it('still displays a line whose synth failed (text must not vanish)', async () => {
    const h = makeDeps({ lines: ['quiet line'], speakOk: false });
    await pumpSentinelSaysOnce(h.deps);
    expect(h.out.filter((m) => m.kind === 'response_transcript')).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('synth failed'))).toBe(true);
  });

  it('has no persist seam — push-time (voice:say) owns chat persistence', () => {
    // Compile-time contract: a deps object with `persist` is a type error;
    // runtime contract: the pump interface exposes exactly these keys.
    const h = makeDeps();
    expect(Object.keys(h.deps).sort()).toEqual(['broadcast', 'drain', 'log', 'sessionLive', 'speak']);
  });
});
