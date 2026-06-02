// @vitest-environment jsdom
/**
 * Side-channel voice narration engine (voice-narration.ts) — the long-op
 * announcement dispatcher that bypasses the live agent and POSTs deterministic
 * templates to the TTS-preview endpoint. Untested. We mock the template policy
 * + the audio/TTS sink and cover the engine logic that matters:
 *   - prefs gating: narration is suppressed when the user opted out, or when a
 *     full-agent engine (EL Conv AI / Realtime) is active (would double-voice);
 *   - announceOpStart speaks the kickoff line and schedules mid-update lines on
 *     the policy cadence;
 *   - handle.cancel() / announceOpEnd stop pending mid timers;
 *   - announceOpEnd speaks the completion line.
 *
 * P-017 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./op-narration-policy', () => ({
  OP_POLICIES: { testop: { midMaxFires: 2, midFirstAt: 1000, midCadenceMs: 5000 } },
  kickoffText: vi.fn(() => 'kickoff line'),
  midText: vi.fn((_k: string, i: number) => `mid ${i}`),
  completionText: vi.fn(() => ({ text: 'done line', mode: 'default' })),
}));

import {
  announceOpStart,
  announceOpEnd,
  __resetNarrationStateForTests,
} from './voice-narration';
import type { OpKind } from './op-narration-policy';

const KIND = 'testop' as unknown as OpKind;

/** All fetch calls; helper to count TTS-preview (spoken) hits. */
let fetchMock: ReturnType<typeof vi.fn>;
function ttsCalls() {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('operator-tts-preview'));
}
function spokenTexts(): string[] {
  return ttsCalls().map((c) => JSON.parse(String((c[1] as RequestInit).body)).text as string);
}

function stubFetch(prefs: Record<string, unknown>) {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('operator-voice-prefs')) {
      return new Response(JSON.stringify(prefs), { status: 200 });
    }
    // tts-preview → an audio blob
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  __resetNarrationStateForTests();
  // Audio + object URLs aren't real in jsdom; stub so speak() completes.
  vi.stubGlobal(
    'Audio',
    class {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(u?: string) {
        this.src = u ?? '';
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
    },
  );
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the async speak() chain (prefs fetch → tts fetch → Audio) settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('voice-narration — prefs gating', () => {
  it('speaks the kickoff when narration is enabled', async () => {
    stubFetch({ narrateLongOps: true, fullAgentEngine: 'off' });
    announceOpStart(KIND).cancel();
    await settle();
    expect(spokenTexts()).toContain('kickoff line');
  });

  it('suppresses narration when the user opted out (narrateLongOps:false)', async () => {
    stubFetch({ narrateLongOps: false });
    announceOpStart(KIND).cancel();
    await settle();
    expect(ttsCalls()).toHaveLength(0);
  });

  it('suppresses narration when a full-agent engine is active (avoids double-voice)', async () => {
    stubFetch({ narrateLongOps: true, fullAgentEngine: 'elevenlabs-conv' });
    announceOpStart(KIND).cancel();
    await settle();
    expect(ttsCalls()).toHaveLength(0);
  });
});

describe('voice-narration — scheduling + lifecycle', () => {
  it('fires mid-update lines on the policy cadence, up to midMaxFires', async () => {
    vi.useFakeTimers();
    stubFetch({ narrateLongOps: true, fullAgentEngine: 'off' });
    announceOpStart(KIND);
    await vi.advanceTimersByTimeAsync(1000); // midFirstAt → mid 0
    await vi.advanceTimersByTimeAsync(5000); // midCadenceMs → mid 1
    await vi.advanceTimersByTimeAsync(5000); // would be mid 2, but capped at 2 fires
    const spoken = spokenTexts();
    expect(spoken).toContain('mid 0');
    expect(spoken).toContain('mid 1');
    expect(spoken).not.toContain('mid 2');
  });

  it('handle.cancel() stops pending mid timers', async () => {
    vi.useFakeTimers();
    stubFetch({ narrateLongOps: true, fullAgentEngine: 'off' });
    const handle = announceOpStart(KIND);
    handle.cancel();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spokenTexts().some((t) => t.startsWith('mid'))).toBe(false);
  });

  it('announceOpEnd cancels pending mids and speaks the completion line', async () => {
    vi.useFakeTimers();
    stubFetch({ narrateLongOps: true, fullAgentEngine: 'off' });
    const handle = announceOpStart(KIND);
    announceOpEnd(KIND, { outcome: 'ok' } as never, handle);
    await vi.advanceTimersByTimeAsync(20_000);
    const spoken = spokenTexts();
    expect(spoken).toContain('done line');
    expect(spoken.some((t) => t.startsWith('mid'))).toBe(false);
  });
});
