/**
 * Unit coverage for voice-utterance-log (Gap-6). The single collaborator —
 * `withWorkspace` from @papercusp/db-org — is mocked with an in-memory
 * capture so we can assert the *bound values* of the append-only INSERT
 * (source normalization, null-coercion of malformed fields, boolean
 * defaults) and the two error branches (missing-table degrade vs db-error)
 * without a real Postgres.
 *
 * The INSERT's VALUES(...) order (see voice-utterance-log.ts) is:
 *   workspace, source, mode, length_chars, name_used, had_backstory, modifications
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted; the capture + throw-control must be too.
const { calls, throwError } = vi.hoisted(() => ({
  // Each INSERT pushes its interpolated tagged-template values here.
  calls: [] as unknown[][],
  // Set to an Error to make the tx tagged-template throw (exercises the
  // degrade / db-error branches).
  throwError: { value: null as Error | null },
}));

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('@papercusp/db-org', () => ({
  // withWorkspace(workspace, cb) invokes cb with a `tx` tagged-template fn.
  // The fn captures the interpolated VALUES (everything after the first
  // template string chunk) so the test can read them by index.
  withWorkspace: async (_workspace: string, cb: (tx: unknown) => Promise<void>) => {
    const tx = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
      if (throwError.value) throw throwError.value;
      calls.push(values);
      return Promise.resolve([]);
    };
    return cb(tx);
  },
}));

import { logVoiceUtterance } from './voice-utterance-log';

// Column order of the VALUES(...) — index into a captured call.
const COL = {
  workspace: 0,
  source: 1,
  mode: 2,
  lengthChars: 3,
  nameUsed: 4,
  hadBackstory: 5,
  modifications: 6,
} as const;

beforeEach(() => {
  calls.length = 0;
  throwError.value = null;
});

describe('logVoiceUtterance — source normalization', () => {
  it('coerces an unknown source to "legacy"', async () => {
    const r = await logVoiceUtterance({ source: 'bogus' });
    expect(r).toEqual({ ok: true });
    expect(calls[0][COL.source]).toBe('legacy');
  });

  it('passes through an allowed source ("realtime")', async () => {
    const r = await logVoiceUtterance({ source: 'realtime' });
    expect(r).toEqual({ ok: true });
    expect(calls[0][COL.source]).toBe('realtime');
  });

  it('defaults a missing source to "legacy"', async () => {
    await logVoiceUtterance({});
    expect(calls[0][COL.source]).toBe('legacy');
  });
});

describe('logVoiceUtterance — field coercion', () => {
  it('coerces a missing mode to null', async () => {
    await logVoiceUtterance({ mode: undefined });
    expect(calls[0][COL.mode]).toBeNull();
  });

  it('coerces a non-numeric lengthChars to null', async () => {
    // lengthChars is typed number, but the route forwards untyped JSON; a
    // string must not reach the INSERT as a string.
    await logVoiceUtterance({ lengthChars: 'x' as unknown as number });
    expect(calls[0][COL.lengthChars]).toBeNull();
  });

  it('preserves a real numeric lengthChars', async () => {
    await logVoiceUtterance({ lengthChars: 42 });
    expect(calls[0][COL.lengthChars]).toBe(42);
  });

  it('defaults a missing nameUsed to false (never null)', async () => {
    await logVoiceUtterance({ nameUsed: undefined });
    expect(calls[0][COL.nameUsed]).toBe(false);
  });

  it('binds the active workspace as the row workspace', async () => {
    await logVoiceUtterance({});
    expect(calls[0][COL.workspace]).toBe('ws-test');
  });
});

describe('logVoiceUtterance — error branches', () => {
  it('degrades silently when the voice_utterances table is missing', async () => {
    throwError.value = new Error(
      'relation "harness_shared.voice_utterances" does not exist',
    );
    const r = await logVoiceUtterance({ source: 'realtime' });
    expect(r).toEqual({ ok: true, degraded: true });
  });

  it('returns a db-error for any other thrown error', async () => {
    throwError.value = new Error('connection refused');
    const r = await logVoiceUtterance({ source: 'realtime' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('db-error');
    expect(r.detail).toContain('connection refused');
  });
});
