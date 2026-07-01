/**
 * sentinel-says-pump unit tests (voice-unified-sentinel-pipeline-2026-07-01,
 * P-002/P-004): the pane's voice:say lines are displayed + spoken + persisted
 * through the bus while a session is live, and the FIFO is left alone (for the
 * webview's local-mode drain) when no session is live.
 */
import { describe, expect, it, vi } from 'vitest';
import { FrameDecoder } from '@papercusp/p2p-voice';
import { pumpSentinelSaysOnce, type SentinelSaysPumpDeps } from './sentinel-says-pump';
import { decodeOpVoiceFrame, type OpVoiceMessage } from './operator-voice-bus';

function makeDeps(opts: { live?: boolean; lines?: string[]; speakOk?: boolean } = {}) {
  const out: OpVoiceMessage[] = [];
  const spoken: string[] = [];
  const persisted: string[] = [];
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
    persist: vi.fn(async (text: string) => {
      persisted.push(text);
    }),
    log: (msg) => logs.push(msg),
  };
  return { deps, out, spoken, persisted, logs, drain };
}

describe('pumpSentinelSaysOnce', () => {
  it('leaves the FIFO alone when no session is live (webview local-mode owns it)', async () => {
    const h = makeDeps({ live: false, lines: ['hello'] });
    const n = await pumpSentinelSaysOnce(h.deps);
    expect(n).toBe(0);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('displays + speaks + persists each drained line, in order', async () => {
    const h = makeDeps({ lines: ['first answer', 'second answer'] });
    const n = await pumpSentinelSaysOnce(h.deps);
    expect(n).toBe(2);
    const transcripts = h.out.filter((m) => m.kind === 'response_transcript');
    expect(transcripts.map((t) => (t as { text: string }).text)).toEqual(['first answer', 'second answer']);
    expect(h.spoken).toEqual(['first answer', 'second answer']);
    expect(h.persisted).toEqual(['first answer', 'second answer']);
  });

  it('still displays + persists a line whose synth failed (text must not vanish)', async () => {
    const h = makeDeps({ lines: ['quiet line'], speakOk: false });
    await pumpSentinelSaysOnce(h.deps);
    expect(h.out.filter((m) => m.kind === 'response_transcript')).toHaveLength(1);
    expect(h.persisted).toEqual(['quiet line']);
    expect(h.logs.some((l) => l.includes('synth failed'))).toBe(true);
  });
});
