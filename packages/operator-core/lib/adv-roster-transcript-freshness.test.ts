/**
 * `resolveTranscriptFreshnessForEntries` — per-backend resolver selection
 * (WI-41497 / WI-41499).
 *
 * The old first test was `if (e.sessionId)` → the CLAUDE resolver. But a codex
 * adv row carries its rollout uuid in `session_id` (verified: adv 18014's
 * session_id IS its rollout filename's uuid), so 237 of 257 live codex rows
 * took the claude leg, missed, and were stamped `thinkingResolvable: false`.
 * The codex leg below it was consequently DEAD for every row that had a
 * sessionId, and NEITHER non-claude leg ever assigned `thinkingResolvable` at
 * all.
 *
 * That false verdict is not cosmetic: it puts a "no live transcript — it has
 * ended, or its transcript was rotated away" banner over a healthy streaming
 * agent, adds `ended=1` to a LIVE session's stream URL, keeps the thinking dot
 * dark, and makes AgentsRunningPill veto the live-thinking affordance outright.
 *
 * Nothing covered this branch before. These tests assert WHICH resolver each
 * row shape reaches — the thing the bug got wrong — by observing the calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSessionThinkingState = vi.fn();
const resolveCodexThinkingState = vi.fn();
const resolveOmpThinkingState = vi.fn();

vi.mock('./claude-sessions', () => ({
  resolveSessionThinkingState,
  SESSION_THINKING_ACTIVE_MS: 60_000,
}));

vi.mock('./session-transcript-resolvers', () => ({
  resolveCodexThinkingState,
  resolveOmpThinkingState,
}));

const { resolveTranscriptFreshnessForEntries } = await import('./adv-roster');

type Entry = Parameters<typeof resolveTranscriptFreshnessForEntries>[0][number];

/** A roster row with only the fields this resolver reads. */
function row(over: Partial<Entry>): Entry {
  return {
    ownerId: 'su-0000',
    sessionId: null,
    advSessionId: null,
    ompThreadId: null,
    agent: null,
    nativeSession: null,
    transcriptFresh: false,
    thinking: false,
    thinkingResolvable: true,
    ...over,
  } as Entry;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSessionThinkingState.mockResolvedValue({ resolvable: true, thinking: true });
  resolveCodexThinkingState.mockResolvedValue({ resolvable: true, thinking: true });
  resolveOmpThinkingState.mockResolvedValue({ resolvable: true, thinking: true });
});

describe('backend selection — the WI-41497 misread', () => {
  it('a codex row whose sessionId holds its rollout uuid does NOT take the claude leg', () => {
    // THE REGRESSION, verbatim from the live shape: adv 18014's session_id is
    // the rollout uuid, and `if (e.sessionId)` therefore captured it.
    const e = row({
      sessionId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
      advSessionId: 18014,
      nativeSession: { backend: 'codex', rolloutId: '01a03683-05ce-7001-bfde-ec00081c4aa7' } as Entry['nativeSession'],
    });

    return resolveTranscriptFreshnessForEntries([e]).then(() => {
      expect(resolveSessionThinkingState).not.toHaveBeenCalled();
      expect(resolveCodexThinkingState).toHaveBeenCalledTimes(1);
      // Keyed by the ADV ROW id — that names the per-session CODEX_HOME, which
      // is where a psu-launched codex agent actually writes.
      expect(resolveCodexThinkingState.mock.calls[0]![0]).toBe(18014);
    });
  });

  it('an omp row whose sessionId holds its thread uuid does NOT take the claude leg', async () => {
    const e = row({
      sessionId: '01a036bd-eab0-7265-8ade-13cac5d74ae9',
      advSessionId: 18080,
      ompThreadId: '01a036bd-eab0-7265-8ade-13cac5d74ae9',
      nativeSession: { backend: 'omp', ompThreadId: '01a036bd-eab0-7265-8ade-13cac5d74ae9' } as Entry['nativeSession'],
    });

    await resolveTranscriptFreshnessForEntries([e]);

    expect(resolveSessionThinkingState).not.toHaveBeenCalled();
    expect(resolveOmpThinkingState).toHaveBeenCalledTimes(1);
  });

  it('falls back to `agent` when the row predates nativeSession.backend', async () => {
    await resolveTranscriptFreshnessForEntries([
      row({ agent: 'codex', advSessionId: 300, sessionId: 'looks-like-a-uuid' }),
      row({ agent: 'omp', advSessionId: 301, ompThreadId: 'thread-301', sessionId: 'also-a-uuid' }),
    ]);

    expect(resolveSessionThinkingState).not.toHaveBeenCalled();
    expect(resolveCodexThinkingState).toHaveBeenCalledTimes(1);
    expect(resolveOmpThinkingState).toHaveBeenCalledTimes(1);
  });

  it('a bare sessionId with no backend hint still means claude (a bee / presence row)', async () => {
    await resolveTranscriptFreshnessForEntries([row({ sessionId: 'claude-uuid', ownerId: 'su-abc' })]);

    expect(resolveCodexThinkingState).not.toHaveBeenCalled();
    expect(resolveOmpThinkingState).not.toHaveBeenCalled();
    expect(resolveSessionThinkingState).toHaveBeenCalledWith(
      'claude-uuid',
      expect.objectContaining({ owner: 'su-abc' }),
    );
  });

  it('nativeSession.backend OUTRANKS the agent column when they disagree', async () => {
    // `agent` is the legacy fallback; the handle is the canonical answer.
    await resolveTranscriptFreshnessForEntries([
      row({ agent: 'codex', advSessionId: 400, ompThreadId: 'thread-400',
            nativeSession: { backend: 'omp', ompThreadId: 'thread-400' } as Entry['nativeSession'] }),
    ]);

    expect(resolveCodexThinkingState).not.toHaveBeenCalled();
    expect(resolveOmpThinkingState).toHaveBeenCalledTimes(1);
  });
});

describe('every backend ASSIGNS thinkingResolvable', () => {
  // The second half of WI-41497: both non-claude legs resolved a transcript and
  // then dropped the verdict on the floor, leaving whatever the roster had
  // defaulted to. A row is only honest if the leg that resolved it wrote back.
  it.each([
    ['codex', () => row({ advSessionId: 18014, nativeSession: { backend: 'codex', rolloutId: 'r' } as Entry['nativeSession'] })],
    ['omp', () => row({ advSessionId: 18080, ompThreadId: 't', nativeSession: { backend: 'omp', ompThreadId: 't' } as Entry['nativeSession'] })],
    ['claude', () => row({ sessionId: 'claude-uuid' })],
  ])('%s: an UNRESOLVABLE transcript flips thinkingResolvable to false', async (_backend, make) => {
    resolveSessionThinkingState.mockResolvedValue({ resolvable: false, thinking: false });
    resolveCodexThinkingState.mockResolvedValue({ resolvable: false, thinking: false });
    resolveOmpThinkingState.mockResolvedValue({ resolvable: false, thinking: false });

    const e = make();
    e.thinkingResolvable = true;
    await resolveTranscriptFreshnessForEntries([e]);

    expect(e.thinkingResolvable).toBe(false);
    expect(e.transcriptFresh).toBe(false);
  });

  it.each([
    ['codex', () => row({ advSessionId: 18014, nativeSession: { backend: 'codex', rolloutId: 'r' } as Entry['nativeSession'] })],
    ['omp', () => row({ advSessionId: 18080, ompThreadId: 't', nativeSession: { backend: 'omp', ompThreadId: 't' } as Entry['nativeSession'] })],
    ['claude', () => row({ sessionId: 'claude-uuid' })],
  ])('%s: a fresh transcript sets transcriptFresh AND resolvable', async (_backend, make) => {
    const e = make();
    e.thinkingResolvable = false;
    await resolveTranscriptFreshnessForEntries([e]);

    expect(e.thinkingResolvable).toBe(true);
    expect(e.transcriptFresh).toBe(true);
    // Deprecated alias, still read by the pill — must not drift from the real signal.
    expect(e.thinking).toBe(true);
  });
});

describe('resolver keying', () => {
  it('omp passes the adv row id as sessionKey, so the per-session home is searched', async () => {
    // WI-41496 one layer up: without this the resolver falls back to a bounded
    // sweep, which works but re-scans on every 1 Hz roster refresh.
    await resolveTranscriptFreshnessForEntries([
      row({ advSessionId: 18080, ompThreadId: 'thread-x',
            nativeSession: { backend: 'omp', ompThreadId: 'thread-x' } as Entry['nativeSession'] }),
    ]);

    expect(resolveOmpThinkingState).toHaveBeenCalledWith(
      'thread-x',
      expect.objectContaining({ sessionKey: 18080 }),
    );
  });

  it('codex falls back to the rollout uuid when the row has no adv id (a federated row)', async () => {
    await resolveTranscriptFreshnessForEntries([
      row({ advSessionId: null,
            nativeSession: { backend: 'codex', rolloutId: 'rollout-uuid' } as Entry['nativeSession'] }),
    ]);

    expect(resolveCodexThinkingState.mock.calls[0]![0]).toBe('rollout-uuid');
  });

  it('an omp row with no thread id anywhere is left alone rather than mis-resolved', async () => {
    const e = row({ advSessionId: 1, nativeSession: { backend: 'omp', ompThreadId: null } as Entry['nativeSession'] });
    await resolveTranscriptFreshnessForEntries([e]);

    expect(resolveOmpThinkingState).not.toHaveBeenCalled();
    expect(resolveSessionThinkingState).not.toHaveBeenCalled();
  });
});

describe('falsifiability — the PRE-FIX branch, kept as a permanent control', () => {
  // The tests above pass. That is only meaningful if they would FAIL on the old
  // code — and the old code was green for weeks, so "it passes now" proves
  // nothing on its own. This is the pre-fix selection kept verbatim, asserted
  // to pick the WRONG backend for the exact row shapes measured live.
  //
  // Kept as an in-file control rather than reconstructed by mutating
  // adv-roster.ts: a mutation probe holds a shared-tree file wrong for the
  // length of a suite run, and git-sync sweeps the whole tree on a schedule.
  type Shape = Pick<Entry, 'sessionId' | 'agent' | 'nativeSession'>;

  /** Pre-WI-41497: `if (e.sessionId)` was tested FIRST. */
  const preFixBackend = (e: Shape): string | null =>
    e.sessionId ? 'claude' : (e.agent === 'codex' || e.agent === 'omp' ? e.agent : null);

  /** Current: the backend decides, and a bare sessionId is the FALLBACK. */
  const currentBackend = (e: Shape): string | null =>
    e.nativeSession?.backend
    ?? (e.agent === 'codex' || e.agent === 'omp' ? e.agent : null)
    ?? (e.sessionId ? 'claude' : null);

  it('mislabels a real codex row as claude — the 237-of-257 misread', () => {
    // adv 18014's session_id IS its rollout uuid, which is what made
    // `if (e.sessionId)` swallow every live codex row.
    const codexRow: Shape = {
      sessionId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
      agent: 'codex',
      nativeSession: { backend: 'codex', rolloutId: '01a03683-05ce-7001-bfde-ec00081c4aa7' } as Entry['nativeSession'],
    };

    expect(preFixBackend(codexRow)).toBe('claude');   // ← the bug
    expect(currentBackend(codexRow)).toBe('codex');   // ← calibration
  });

  it('mislabels a real omp row as claude', () => {
    const ompRow: Shape = {
      sessionId: '01a036bd-eab0-7265-8ade-13cac5d74ae9',
      agent: 'omp',
      nativeSession: { backend: 'omp', ompThreadId: '01a036bd-eab0-7265-8ade-13cac5d74ae9' } as Entry['nativeSession'],
    };

    expect(preFixBackend(ompRow)).toBe('claude');
    expect(currentBackend(ompRow)).toBe('omp');
  });

  it('AGREES on a genuine claude row — which is why the bug was invisible', () => {
    // The rows the old branch got right were the ones anybody would have
    // spot-checked: an interactive claude session has no backend handle and a
    // real sessionId, so both readings say claude.
    const claudeRow: Shape = { sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0', agent: null, nativeSession: null };

    expect(preFixBackend(claudeRow)).toBe('claude');
    expect(currentBackend(claudeRow)).toBe('claude');
  });

  it('and the live path really does follow the CURRENT reading, not the control', () => {
    // Ties the control to the subject: without this the two functions above
    // could drift from adv-roster and keep passing on their own.
    return resolveTranscriptFreshnessForEntries([
      row({
        sessionId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
        advSessionId: 18014,
        agent: 'codex',
        nativeSession: { backend: 'codex', rolloutId: 'r' } as Entry['nativeSession'],
      }),
    ]).then(() => {
      expect(resolveCodexThinkingState).toHaveBeenCalledTimes(1);
      expect(resolveSessionThinkingState).not.toHaveBeenCalled();
    });
  });
});

describe('resilience', () => {
  it('resolves entries in PARALLEL, never a serial fs loop', async () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      row({ advSessionId: i, nativeSession: { backend: 'codex', rolloutId: `r${i}` } as Entry['nativeSession'] }));

    let inFlight = 0;
    let peak = 0;
    resolveCodexThinkingState.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return { resolvable: true, thinking: true };
    });

    await resolveTranscriptFreshnessForEntries(entries);
    expect(peak).toBeGreaterThan(1);
  });

  it('a throwing resolver leaves its row untouched instead of failing the roster', async () => {
    // This runs on the roster's latency-critical path; one unreadable
    // transcript must not take out the whole read.
    resolveCodexThinkingState.mockRejectedValue(new Error('EACCES'));
    const e = row({ advSessionId: 1, nativeSession: { backend: 'codex', rolloutId: 'r' } as Entry['nativeSession'] });
    e.thinkingResolvable = true;

    await expect(resolveTranscriptFreshnessForEntries([e])).resolves.toBeUndefined();
    expect(e.thinkingResolvable).toBe(true);
  });

  it('is a no-op on an empty list (imports nothing)', async () => {
    await resolveTranscriptFreshnessForEntries([]);
    expect(resolveSessionThinkingState).not.toHaveBeenCalled();
    expect(resolveCodexThinkingState).not.toHaveBeenCalled();
    expect(resolveOmpThinkingState).not.toHaveBeenCalled();
  });
});
