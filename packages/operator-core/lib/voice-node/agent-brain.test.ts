import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetVoiceAgentBrainForTest,
  enableVoiceAgentBrain,
  voiceAgentBrainEnabled,
  voiceAgentSpeaking,
  type BrainSeams,
  type ConverseMessage,
} from './agent-brain';
import { enableVoiceAgent, type VoiceTranscript } from './agent-peer';

function transcript(text: string): VoiceTranscript {
  return { peerId: 'B', text, seconds: 1, at: 0 };
}

function makeHarness(
  opts: {
    converseReply?: () => Promise<string | null>;
    sayImpl?: (text: string) => Promise<number>;
  } = {},
) {
  const converseCalls: ConverseMessage[][] = [];
  const saidTexts: string[] = [];
  let emit: (t: VoiceTranscript) => void = () => {};
  const seams: BrainSeams = {
    converse: async (messages) => {
      converseCalls.push(messages.map((m) => ({ ...m })));
      return opts.converseReply ? opts.converseReply() : 'hello there';
    },
    say: async (text) => {
      saidTexts.push(text);
      return opts.sayImpl ? opts.sayImpl(text) : 5;
    },
    onTranscript: (cb) => {
      emit = cb;
      return () => {
        emit = () => {};
      };
    },
  };
  return { seams, converseCalls, saidTexts, fire: (t: string) => emit(transcript(t)) };
}

afterEach(() => {
  __resetVoiceAgentBrainForTest();
  enableVoiceAgent(false);
});

describe('voice agent brain (P-011)', () => {
  it('runs transcript → converse → say', async () => {
    const { seams, converseCalls, saidTexts, fire } = makeHarness();
    enableVoiceAgentBrain(true, seams);
    expect(voiceAgentBrainEnabled()).toBe(true);
    fire('what is the status');
    await vi.waitFor(() => expect(saidTexts.length).toBe(1));
    expect(converseCalls[0].at(-1)).toEqual({ role: 'user', content: 'what is the status' });
    expect(saidTexts[0]).toBe('hello there');
    expect(voiceAgentSpeaking()).toBe(false); // cleared once say resolves
  });

  it('serializes turns — a transcript arriving mid-turn is dropped', async () => {
    let release: () => void = () => {};
    const gate = new Promise<string | null>((r) => {
      release = () => r('ok');
    });
    const { seams, converseCalls, fire } = makeHarness({ converseReply: () => gate });
    enableVoiceAgentBrain(true, seams);
    fire('first');
    await vi.waitFor(() => expect(converseCalls.length).toBe(1));
    fire('second'); // dropped — brain busy
    fire('third'); // dropped — brain busy
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(converseCalls.length).toBe(1);
  });

  it('stays silent when converse returns no <say>', async () => {
    const { seams, saidTexts, fire } = makeHarness({ converseReply: async () => null });
    enableVoiceAgentBrain(true, seams);
    fire('mumble');
    await new Promise((r) => setTimeout(r, 10));
    expect(saidTexts.length).toBe(0);
  });

  it('ignores empty/whitespace transcripts', async () => {
    const { seams, converseCalls, fire } = makeHarness();
    enableVoiceAgentBrain(true, seams);
    fire('   ');
    await new Promise((r) => setTimeout(r, 10));
    expect(converseCalls.length).toBe(0);
  });

  it('accumulates rolling history across turns', async () => {
    const { seams, converseCalls, saidTexts, fire } = makeHarness();
    enableVoiceAgentBrain(true, seams);
    fire('one');
    // Wait for the FIRST turn to fully wind down (spoke + busy cleared) before
    // firing the second — else the serialize guard drops it.
    await vi.waitFor(() => expect(saidTexts.length).toBe(1));
    await new Promise((r) => setTimeout(r, 5));
    fire('two');
    await vi.waitFor(() => expect(converseCalls.length).toBe(2));
    expect(converseCalls[1]).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'hello there' },
      { role: 'user', content: 'two' },
    ]);
  });

  it('does not leave a dangling user turn when the brain stays silent', async () => {
    const replies: (string | null)[] = [null, 'hi there'];
    let i = 0;
    const { seams, converseCalls, fire } = makeHarness({
      converseReply: async () => replies[i++],
    });
    enableVoiceAgentBrain(true, seams);
    fire('silent one'); // brain stays silent → records nothing
    await vi.waitFor(() => expect(converseCalls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 5));
    fire('real two');
    await vi.waitFor(() => expect(converseCalls.length).toBe(2));
    // The 2nd converse sees ONLY its own user turn — the silent 1st turn left
    // no dangling user message in history (alternation preserved).
    expect(converseCalls[1]).toEqual([{ role: 'user', content: 'real two' }]);
  });

  it('reports speaking while the reply is being spoken', async () => {
    let releaseSay: () => void = () => {};
    const sayGate = new Promise<number>((r) => {
      releaseSay = () => r(7);
    });
    const { seams, fire } = makeHarness({ sayImpl: () => sayGate });
    enableVoiceAgentBrain(true, seams);
    fire('hi');
    await vi.waitFor(() => expect(voiceAgentSpeaking()).toBe(true));
    releaseSay();
    await vi.waitFor(() => expect(voiceAgentSpeaking()).toBe(false));
  });

  it('disabling mid-flight suppresses the spoken reply', async () => {
    let release: () => void = () => {};
    const gate = new Promise<string | null>((r) => {
      release = () => r('late reply');
    });
    const { seams, saidTexts, fire } = makeHarness({ converseReply: () => gate });
    enableVoiceAgentBrain(true, seams);
    fire('hello');
    await new Promise((r) => setTimeout(r, 5));
    enableVoiceAgentBrain(false); // disabled while converse is in flight
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(saidTexts.length).toBe(0); // reply suppressed after disable
  });
});
