/**
 * plugin-enables-pg.test.ts — EI-300 leg 2: the mirror must write
 * `enabled_at` as BIGINT epoch-ms, never the enabled-plugins.json ISO
 * string (which made every fresh-DB INSERT fail and retry forever on the
 * production .deb first run).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock('@papercusp/db-org', () => {
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.queries.push({ text: strings.join('¿'), values });
    return Promise.resolve([]);
  };
  // tx(<array>) helper form (used for `NOT IN ${tx(slugs)}`)
  const callable = Object.assign(tx, {});
  return {
    withWorkspace: async (_ws: string, fn: (t: unknown) => Promise<unknown>) => fn(callable),
  };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

let tmpRoot: string;
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...segs: string[]) => join(tmpRoot, ...segs),
}));

import { mirrorHarness, enabledAtEpochMs } from './plugin-enables-pg';

describe('enabledAtEpochMs', () => {
  it('parses the ISO string the CLI writes into epoch ms', () => {
    expect(enabledAtEpochMs('2026-06-10T10:58:51.426Z')).toBe(Date.parse('2026-06-10T10:58:51.426Z'));
  });
  it('passes through numeric epoch-ms (number and numeric string)', () => {
    expect(enabledAtEpochMs(1781089131426)).toBe(1781089131426);
    expect(enabledAtEpochMs('1781089131426')).toBe(1781089131426);
  });
  it('falls back to now() for garbage/missing values', () => {
    const before = Date.now();
    for (const v of [undefined, null, '', 'not-a-date', NaN]) {
      const got = enabledAtEpochMs(v);
      expect(got).toBeGreaterThanOrEqual(before);
      expect(got).toBeLessThanOrEqual(Date.now());
    }
  });
});

describe('mirrorHarness', () => {
  beforeEach(() => {
    h.queries.length = 0;
    tmpRoot = mkdtempSync(join(tmpdir(), 'plugin-enables-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeEnabledFile(harness: string, enabled: Record<string, unknown>) {
    const dir = join(tmpRoot, 'harnesses', harness);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'enabled-plugins.json'), JSON.stringify({ enabled }));
  }

  it('inserts enabled_at as a NUMBER (epoch ms of the file ISO), never the ISO string', async () => {
    writeEnabledFile('h1', {
      'my-plugin': { version: '1.0.0', enabledAt: '2026-06-10T10:58:51.426Z', configHash: 'abc' },
    });
    await mirrorHarness('h1');

    const insert = h.queries.find((q) => q.text.includes('INSERT INTO harness_shared.plugin_enables'));
    expect(insert).toBeTruthy();
    const expectedMs = Date.parse('2026-06-10T10:58:51.426Z');
    expect(insert!.values).toContain(expectedMs);
    // The regression: no parameter may be the raw ISO string.
    expect(insert!.values).not.toContain('2026-06-10T10:58:51.426Z');
  });

  it('missing enabledAt still yields a numeric enabled_at', async () => {
    writeEnabledFile('h2', { p: { version: '0.1.0', configHash: '' } });
    const before = Date.now();
    await mirrorHarness('h2');

    const insert = h.queries.find((q) => q.text.includes('INSERT INTO harness_shared.plugin_enables'));
    const numeric = insert!.values.filter((v): v is number => typeof v === 'number');
    expect(numeric.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...numeric)).toBeGreaterThanOrEqual(before);
  });

  it('empty enables file → delete-all path, no insert', async () => {
    writeEnabledFile('h3', {});
    await mirrorHarness('h3');
    expect(h.queries.some((q) => q.text.includes('INSERT INTO'))).toBe(false);
    expect(h.queries.some((q) => q.text.includes('DELETE FROM harness_shared.plugin_enables'))).toBe(true);
  });
});
