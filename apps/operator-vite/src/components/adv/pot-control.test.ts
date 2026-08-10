import { afterEach, describe, it, expect, vi } from 'vitest';
import { countStarted, hivesRunningLabel, runHiveControl, type HiveControlRow } from './hive-control';

const row = (slug: string, started: boolean): HiveControlRow => ({ slug, started });

describe('countStarted', () => {
  it('counts only started hives', () => {
    expect(countStarted([row('a', true), row('b', false), row('c', true)])).toBe(2);
  });
  it('is 0 for empty + all-stopped', () => {
    expect(countStarted([])).toBe(0);
    expect(countStarted([row('a', false), row('b', false)])).toBe(0);
  });
  it('requires started===true (no truthy coercion on a partial row)', () => {
    // The predicate is strict so a missing/odd `started` never counts as running.
    const rows = [{ slug: 'x', started: true }, { slug: 'y', started: false }] as HiveControlRow[];
    expect(countStarted(rows)).toBe(1);
  });
});

describe('hivesRunningLabel', () => {
  it('pluralizes the hive count', () => {
    expect(hivesRunningLabel(0)).toBe('0 hives running');
    expect(hivesRunningLabel(1)).toBe('1 hive running');
    expect(hivesRunningLabel(3)).toBe('3 hives running');
  });
});

describe('runHiveControl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the canonical pot:pause drainCups argument', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { content: [{ text: JSON.stringify({ ok: true }) }] },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runHiveControl('pot:pause', 'papercusp', { drainCups: true });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: 'pot:pause',
      args: { harness: 'papercusp', drainCups: true },
      confirmed: true,
    });
  });

  it('surfaces a plain-text validation response instead of throwing JSON SyntaxError', async () => {
    const validation = 'invalid_input: invalid_args: Unrecognized key: "drainBees"';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { content: [{ text: validation }] },
      }),
    }));

    await expect(runHiveControl('pot:pause', 'papercusp')).rejects.toThrow(validation);
  });
});
