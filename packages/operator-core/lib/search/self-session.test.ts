import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSelfSession } from './self-session';

const SID = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveSelfSession — fresh Codex without a rollout', () => {
  it('uses the active adv-session to find the isolated history fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-11801');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'history.jsonl'),
      `${JSON.stringify({ session_id: SID, ts: 1_783_926_209, text: 'audit this session' })}\n`,
    );

    const resolved = await resolveSelfSession('su-current', {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: null,
        omp_thread_id: null,
      }],
    });

    expect(resolved).toEqual({
      sourceKind: 'codex',
      sessionId: SID,
      filePath: join(codexHome, 'history.jsonl'),
    });
  });
});

describe('resolveSelfSession — claude cold-carry respawn chain (WI-5644)', () => {
  const ORIGINAL = '0a52099c-de9f-43d4-ae49-8e72ca176ee8'; // frozen in the discovery record at first launch
  const CURRENT = 'c95d04fe-a291-4879-b93f-b49f9fb75144'; // newest transcript, minted by a later carry-respawn

  async function seedIsolationDir(home: string, owner: string, sessions: Array<{ id: string; mtime: number }>) {
    const proj = join(home, '.papercusp', 'session-claude', owner, 'projects', '-home-marsh-proj');
    await mkdir(proj, { recursive: true });
    for (const s of sessions) {
      const p = join(proj, `${s.id}.jsonl`);
      await writeFile(p, '{}\n');
      await utimes(p, new Date(s.mtime), new Date(s.mtime));
    }
    return proj;
  }

  async function seedDiscoveryRecord(home: string, owner: string, pinnedUuid: string) {
    const ptyDir = join(home, '.papercusp', 'psu-pty');
    await mkdir(ptyDir, { recursive: true });
    // A cold carry-respawn NEVER rewrites the discovery `args`, so `--session-id`
    // stays frozen at the ORIGINAL launch id — the exact staleness of WI-5644.
    await writeFile(
      join(ptyDir, `${owner}.json`),
      JSON.stringify({ command: 'claude', args: ['--session-id', pinnedUuid] }),
    );
  }

  it('resolves to the NEWEST isolation-dir transcript, ignoring the stale pinned --session-id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const owner = 'su-cold-carry';
    const proj = await seedIsolationDir(home, owner, [
      { id: ORIGINAL, mtime: 1_600_000_000_000 }, // original, oldest
      { id: CURRENT, mtime: 1_600_000_600_000 }, // current live, newest
    ]);
    await seedDiscoveryRecord(home, owner, ORIGINAL);

    const resolved = await resolveSelfSession(owner, { home, loadActiveSessions: async () => [] });

    // Pre-fix this returned ORIGINAL (the stale pin) → self-recall missed all
    // post-respawn history. It must resolve to the CURRENT live transcript.
    expect(resolved).toEqual({ sourceKind: 'claude', sessionId: CURRENT, filePath: join(proj, `${CURRENT}.jsonl`) });
  });

  it('falls back to the newest transcript when the pinned session file was archive-reaped (never null)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const owner = 'su-reaped';
    // The pinned ORIGINAL .jsonl is GONE (session-archive-hook deleted it ~15s
    // after that wake ended); only the current transcript survives on disk.
    const proj = await seedIsolationDir(home, owner, [{ id: CURRENT, mtime: 1_600_000_600_000 }]);
    await seedDiscoveryRecord(home, owner, ORIGINAL);

    const resolved = await resolveSelfSession(owner, { home, loadActiveSessions: async () => [] });

    // Pre-fix this returned null → the "could not be pinned to a live transcript"
    // degrade. It must now resolve to the surviving current transcript.
    expect(resolved).toEqual({ sourceKind: 'claude', sessionId: CURRENT, filePath: join(proj, `${CURRENT}.jsonl`) });
  });
});
