import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-audit-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe.skip('audit log (needs PG fixture)', () => {
  it('appends and reads entries', async () => {
    const m = await import('./audit-log');
    await m.appendAudit('h', 'p', { kind: 'consent-granted', data: { userId: 'u1' } });
    await m.appendAudit('h', 'p', { kind: 'setup-started', runId: 'r1' });
    const entries = await m.readAudit('h', 'p');
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('consent-granted');
    expect(entries[1].runId).toBe('r1');
  });

  it('respects sinceTs filter', async () => {
    const m = await import('./audit-log');
    await m.appendAudit('h', 'p', { kind: 'setup-started', ts: '2026-01-01T00:00:00Z' });
    await m.appendAudit('h', 'p', { kind: 'setup-succeeded', ts: '2026-01-02T00:00:00Z' });
    const entries = await m.readAudit('h', 'p', { sinceTs: '2026-01-01T12:00:00Z' });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('setup-succeeded');
  });

  it('truncates when exceeding capMb and inserts a log-truncated marker', async () => {
    const m = await import('./audit-log');
    // Use a tiny cap so we can exercise truncation cheaply.
    const tinyCapMb = 0.001; // ~1 KiB
    for (let i = 0; i < 200; i++) {
      await m.appendAudit('h', 'p', { kind: 'script-output', data: { line: 'x'.repeat(20), n: i } }, tinyCapMb);
    }
    const entries = await m.readAudit('h', 'p');
    const trunc = entries.find((e) => e.kind === 'log-truncated');
    expect(trunc).toBeDefined();
    expect(trunc?.data?.droppedEntries).toBeGreaterThan(0);
  });

  it('returns empty array when no log exists', async () => {
    const m = await import('./audit-log');
    expect(await m.readAudit('h', 'never', {})).toEqual([]);
  });

  it('limit clamps to most recent entries', async () => {
    const m = await import('./audit-log');
    for (let i = 0; i < 10; i++) {
      await m.appendAudit('h', 'p', { kind: 'script-output', data: { n: i } });
    }
    const recent = await m.readAudit('h', 'p', { limit: 3 });
    expect(recent).toHaveLength(3);
    expect(recent[2].data?.n).toBe(9);
  });
});
