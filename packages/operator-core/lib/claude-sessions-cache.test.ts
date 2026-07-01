/**
 * claude-sessions resolution-cache tests — the recurrence guard for the operator
 * memory-bloat root cause (bg-host-freeze-eventloop-stall / WI-1089 leak-hunt tail).
 *
 * The compaction-usage watchdog polled findSessionTranscript on a cadence for MANY
 * owners; with no owner hint + no negative cache, every miss re-ran the full
 * claudeProjectsRoots() sweep (readdir over 12k+ isolation-owner dirs) — ~13 MB/s of
 * `path.join` churn that outpaced GC and grew the background host to tens of GB (a
 * sampling heap profile showed ~84% of allocation was this fs-sweep). These tests pin
 * the two bounds that kill the churn: a TTL negative cache + a TTL roots cache.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let TEST_HOME = '';
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME || actual.homedir() };
});

import { findSessionTranscript, __resetClaudeSessionCaches } from './claude-sessions';

async function setupHome(): Promise<{ home: string; ownerProjDir: string; isoBase: string }> {
  const home = await fs.mkdtemp(join(tmpdir(), 'cs-cache-home-'));
  const isoBase = join(home, '.papercusp', 'session-claude');
  const ownerProjDir = join(isoBase, 'su-owner-x', 'projects', '-home-x-p');
  await fs.mkdir(ownerProjDir, { recursive: true });
  await fs.mkdir(join(home, '.claude', 'projects'), { recursive: true });
  return { home, ownerProjDir, isoBase };
}

describe('claude-sessions resolution caches (memory-bloat churn fix)', () => {
  beforeEach(() => __resetClaudeSessionCaches());

  it('negative cache: a missing id is NOT re-swept within the TTL, and re-resolves after it', async () => {
    const { home, ownerProjDir } = await setupHome();
    TEST_HOME = home;
    try {
      const sid = 'ephemeral-abc123';
      // 1) miss → null; negative-cached at t=1000 (expiry t+30_000).
      expect(await findSessionTranscript(sid, { nowMs: 1000 })).toBeNull();
      // 2) the transcript now appears on disk...
      const target = join(ownerProjDir, `${sid}.jsonl`);
      await fs.writeFile(target, '{}\n');
      // 3) ...but WITHIN the miss TTL the sweep is short-circuited → still null.
      //    (Proves the negative cache is active — without it this would re-scan + resolve.)
      expect(await findSessionTranscript(sid, { nowMs: 1000 })).toBeNull();
      // 4) after the TTL it re-scans and resolves.
      expect(await findSessionTranscript(sid, { nowMs: 1000 + 60_000 })).toBe(target);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      TEST_HOME = '';
    }
  });

  it('roots cache: the 12k-dir isolation-base readdir is built ONCE per TTL window, not per lookup', async () => {
    const { home, isoBase } = await setupHome();
    TEST_HOME = home;
    const readdirSpy = vi.spyOn(fs, 'readdir');
    try {
      // Two DISTINCT missing ids at the same instant — distinct so the negative cache never
      // hits; the expensive isolation-base readdir (the roots build) must be shared via the
      // TTL cache rather than re-run per lookup.
      await findSessionTranscript('miss-aaa-111', { nowMs: 7000 });
      await findSessionTranscript('miss-bbb-222', { nowMs: 7000 });
      const isoBaseReaddirs = readdirSpy.mock.calls.filter((c) => c[0] === isoBase).length;
      expect(isoBaseReaddirs).toBe(1);
    } finally {
      readdirSpy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
      TEST_HOME = '';
    }
  });

  it('explicit-roots callers (tests / targeted scans) bypass the caches entirely', async () => {
    const { home, ownerProjDir } = await setupHome();
    TEST_HOME = home;
    try {
      const sid = 'explicit-def456';
      // A miss with explicit roots must NOT poison a later default-path lookup (no negative
      // caching on the injected-roots path), so once the file exists it resolves immediately.
      expect(await findSessionTranscript(sid, { roots: [], nowMs: 2000 })).toBeNull();
      const target = join(ownerProjDir, `${sid}.jsonl`);
      await fs.writeFile(target, '{}\n');
      // Same instant, explicit roots pointing at the owner projects root → resolves (not cached-missed).
      const ownerProjectsRoot = join(home, '.papercusp', 'session-claude', 'su-owner-x', 'projects');
      expect(await findSessionTranscript(sid, { roots: [ownerProjectsRoot], nowMs: 2000 })).toBe(target);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      TEST_HOME = '';
    }
  });
});
