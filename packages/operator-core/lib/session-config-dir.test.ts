/**
 * WI-38349 — locating a psu Claude session's REAL CLAUDE_CONFIG_DIR.
 *
 * The bug this module exists for: `session-claude/<coordOwnerId>` is a FORMULA that
 * several launch paths do not follow (the orchestrator path keys the dir by spawn id),
 * so reading it found nothing for 78 of 98 owner ids active in a 6h window — which the
 * integrity checker then reported as "RUNNING DE-ENROLLED". Every strategy here must
 * therefore either OBSERVE the dir or decline; a decline is a first-class answer.
 *
 * `/proc` is faked as a directory tree so the live-process strategy is exercised for
 * real (file layout, NUL-delimited environ, the `children` file) with no live process.
 *
 * Run: cd packages/operator-core && npx vitest run lib/session-config-dir.test.ts
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetSessionConfigDirCaches, resolveSessionConfigDir } from './session-config-dir';

const readdirSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      readdirSyncMock(...args);
      return (actual.readdirSync as unknown as (...innerArgs: unknown[]) => unknown)(...args);
    },
  };
});

const OWNER = 'su-e318aa48-85fb-406c-a3ca-caf8c83d883b';
/** The dir the live process actually reads — keyed by a DIFFERENT id (the measured case). */
const REAL_KEY = 'su-4c40b9b3-be16-409e-8bca-a3b933a6a31a';

describe('resolveSessionConfigDir', () => {
  let home: string;
  let procRoot: string;

  const sessionRoot = () => join(home, '.papercusp', 'session-claude');

  /** Lay a fake /proc entry: comm, environ (NUL-delimited), and optional children. */
  const layProc = (
    pid: number,
    { comm, env = {}, children = [] }: { comm: string; env?: Record<string, string>; children?: number[] },
  ) => {
    const dir = join(procRoot, String(pid));
    mkdirSync(join(dir, 'task', String(pid)), { recursive: true });
    writeFileSync(join(dir, 'comm'), `${comm}\n`);
    writeFileSync(
      join(dir, 'environ'),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}\0`)
        .join(''),
    );
    if (children.length) writeFileSync(join(dir, 'task', String(pid), 'children'), `${children.join(' ')} `);
  };

  const layConfigDir = (key: string) => {
    const dir = join(sessionRoot(), key);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const layTranscript = (key: string, sessionId: string) => {
    const dir = join(sessionRoot(), key, 'projects', '-home-u-repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), '{}\n');
    return join(sessionRoot(), key);
  };

  beforeEach(() => {
    __resetSessionConfigDirCaches();
    readdirSyncMock.mockClear();
    home = mkdtempSync(join(tmpdir(), 'wi38349-home-'));
    procRoot = mkdtempSync(join(tmpdir(), 'wi38349-proc-'));
  });
  afterEach(() => {
    __resetSessionConfigDirCaches();
    readdirSyncMock.mockClear();
    rmSync(home, { recursive: true, force: true });
    rmSync(procRoot, { recursive: true, force: true });
  });

  it('reads CLAUDE_CONFIG_DIR off the live claude process when the pid hint IS that process', () => {
    const real = layConfigDir(REAL_KEY);
    layProc(1000, { comm: 'claude', env: { PAPERCUSP_SID: OWNER, CLAUDE_CONFIG_DIR: real } });

    const r = resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 1000, procRoot });

    expect(r).toMatchObject({ dir: real, source: 'live-process', unresolvedReason: null });
  });

  it('follows the pid hint to its CHILD — coord_presence records the launcher, not claude', () => {
    const real = layConfigDir(REAL_KEY);
    layProc(1000, { comm: 'node', env: { PAPERCUSP_LAUNCHER: '1' }, children: [1001] });
    layProc(1001, { comm: 'claude', env: { PAPERCUSP_SID: OWNER, CLAUDE_CONFIG_DIR: real } });

    const r = resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 1000, procRoot });

    expect(r).toMatchObject({ dir: real, source: 'live-process' });
  });

  it('is the MEASURED case: the live dir wins even though it is keyed by a different id', () => {
    const real = layConfigDir(REAL_KEY);
    layProc(1000, { comm: 'claude', env: { PAPERCUSP_SID: OWNER, CLAUDE_CONFIG_DIR: real } });

    const r = resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 1000, procRoot });

    expect(r.dir).toBe(real);
    expect(r.dir).not.toBe(join(sessionRoot(), OWNER)); // the formula's answer, and it is wrong
  });

  it('refuses a RECYCLED pid whose claude belongs to another session', () => {
    layProc(1000, {
      comm: 'claude',
      env: { PAPERCUSP_SID: 'su-somebody-else', CLAUDE_CONFIG_DIR: join(sessionRoot(), 'su-somebody-else') },
    });

    const r = resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 1000, procRoot });

    expect(r.dir).toBeNull();
    expect(r.tried.join(' ')).toMatch(/no claude process/);
  });

  it('falls back to the transcript scan when no process remains (an ENDED session)', () => {
    const real = layTranscript(REAL_KEY, 'bc2de1f1-4b1f-4f3a-8540-04c88f2cfb84');

    const r = resolveSessionConfigDir({
      ownerId: OWNER,
      home,
      procRoot,
      sessionId: 'bc2de1f1-4b1f-4f3a-8540-04c88f2cfb84',
    });

    expect(r).toMatchObject({ dir: real, source: 'transcript-scan' });
  });

  describe("WI-10004654: a fork's seed copy of the transcript never wins over the owner's own dir", () => {
    // A managed fork seeds its own config dir with a copy of the source's
    // `<id>.jsonl`. readdir order is filesystem-specific (XFS lists small dirs in
    // creation order), so each case is laid out both ways round.
    const SID = '8aea8b70-bcb9-48b4-93bd-959d46b7a128';
    for (const forkFirst of [true, false]) {
      it(`resolves the expected owner's dir (fork seed created ${forkFirst ? 'first' : 'second'})`, () => {
        if (forkFirst) layTranscript('su-aaa-fork', SID);
        const own = layTranscript(OWNER, SID);
        if (!forkFirst) layTranscript('su-aaa-fork', SID);

        const r = resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, sessionId: SID });

        expect(r).toMatchObject({ dir: own, source: 'transcript-scan' });
      });

      it(`an alternate owner key is preferred over a fork seed too (fork seed created ${forkFirst ? 'first' : 'second'})`, () => {
        if (forkFirst) layTranscript('su-aaa-fork', SID);
        const real = layTranscript(REAL_KEY, SID);
        if (!forkFirst) layTranscript('su-aaa-fork', SID);

        const r = resolveSessionConfigDir({ ownerId: OWNER, altOwnerIds: [REAL_KEY], home, procRoot, sessionId: SID });

        expect(r).toMatchObject({ dir: real, source: 'transcript-scan' });
      });
    }
  });

  it('caches a validated transcript hit so repeated roster reads skip the directory walk', () => {
    const sessionId = 'cached-transcript-123';
    const real = layTranscript(REAL_KEY, sessionId);

    expect(resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, sessionId })).toMatchObject({
      dir: real,
      source: 'transcript-scan',
    });
    const callsAfterFirstLookup = readdirSyncMock.mock.calls.length;

    expect(resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, sessionId })).toMatchObject({
      dir: real,
      source: 'transcript-scan',
    });
    expect(readdirSyncMock.mock.calls.length).toBe(callsAfterFirstLookup);
  });

  it('caches a short-lived transcript miss so a pre-first-turn session does not rescan the tree', () => {
    const sessionId = 'missing-transcript-123';

    expect(resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, sessionId }).dir).toBeNull();
    const callsAfterFirstLookup = readdirSyncMock.mock.calls.length;

    expect(resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, sessionId }).dir).toBeNull();
    expect(readdirSyncMock.mock.calls.length).toBe(callsAfterFirstLookup);
  });

  it('uses the conventional path only when it EXISTS — and only after the observations', () => {
    const conventional = layConfigDir(OWNER);

    const r = resolveSessionConfigDir({ ownerId: OWNER, home, procRoot });

    expect(r).toMatchObject({ dir: conventional, source: 'conventional' });
  });

  it('a LIVE observation beats a phantom conventional dir left by an earlier bad repair', () => {
    // The regression this ordering exists for: repairing to the formula's path
    // materialized `session-claude/<ownerId>/` that no process ever reads. Once it
    // exists, a conventional-first resolver would diagnose THAT directory forever.
    layConfigDir(OWNER);
    const real = layConfigDir(REAL_KEY);
    layProc(1000, { comm: 'claude', env: { PAPERCUSP_SID: OWNER, CLAUDE_CONFIG_DIR: real } });

    const r = resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 1000, procRoot });

    expect(r.dir).toBe(real);
    expect(r.source).toBe('live-process');
  });

  it('declines with a reason rather than guessing — and names WI-38349 so the null is readable', () => {
    const r = resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 999, procRoot, sessionId: 'no-such' });

    expect(r.dir).toBeNull();
    expect(r.source).toBeNull();
    expect(r.unresolvedReason).toMatch(/WI-38349/);
    expect(r.unresolvedReason).toMatch(/NOT evidence of de-enrollment/);
  });

  it('records every strategy it ran, so a null answer is auditable', () => {
    const r = resolveSessionConfigDir({ ownerId: OWNER, home, procRoot });

    expect(r.tried).toEqual([
      'live-process: skipped (no pid hint)',
      'transcript-scan: skipped (no session id)',
      `conventional(${OWNER}): ${join(sessionRoot(), OWNER)} does not exist`,
    ]);
  });

  // WI-38369: a spawned agent's coord owner id and its SPAWN id differ, and only the
  // spawn id names the directory. `ownerId` must stay the coord owner (the live-process
  // guard compares it to PAPERCUSP_SID), so the extra key rides alongside it.
  describe('altOwnerIds — additional CONVENTIONAL keys', () => {
    it('resolves a dir named by the alternate key when the owner-keyed one never existed', () => {
      const real = layConfigDir(REAL_KEY);

      const r = resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, altOwnerIds: [REAL_KEY] });

      expect(r).toMatchObject({ dir: real, source: 'conventional' });
      expect(r.tried).toContain(`conventional(${OWNER}): ${join(sessionRoot(), OWNER)} does not exist`);
    });

    it('still prefers ownerId when BOTH exist — the alternate is a fallback, not an override', () => {
      const owned = layConfigDir(OWNER);
      layConfigDir(REAL_KEY);

      const r = resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, altOwnerIds: [REAL_KEY] });

      expect(r.dir).toBe(owned);
    });

    it('is an OBSERVATION, not a second formula: a non-existent alternate resolves to null', () => {
      const r = resolveSessionConfigDir({ ownerId: OWNER, home, procRoot, altOwnerIds: [REAL_KEY] });

      expect(r.dir).toBeNull();
      expect(r.source).toBeNull();
      // Both keys are named in the reason, so the null says WHAT was looked for.
      expect(r.unresolvedReason).toContain(`'${OWNER}'`);
      expect(r.unresolvedReason).toContain(`'${REAL_KEY}'`);
    });

    it('an observation still beats the alternate key — ordering is unchanged', () => {
      const scanned = layTranscript(REAL_KEY, 'sess-x');
      layConfigDir('some-third-key');

      const r = resolveSessionConfigDir({
        ownerId: OWNER,
        home,
        procRoot,
        sessionId: 'sess-x',
        altOwnerIds: ['some-third-key'],
      });

      expect(r).toMatchObject({ dir: scanned, source: 'transcript-scan' });
    });

    it('tolerates null/undefined/duplicate keys without probing them twice', () => {
      const r = resolveSessionConfigDir({
        ownerId: OWNER,
        home,
        procRoot,
        altOwnerIds: [null, undefined, OWNER, ''],
      });

      expect(r.dir).toBeNull();
      expect(r.tried.filter((t) => t.startsWith('conventional('))).toEqual([
        `conventional(${OWNER}): ${join(sessionRoot(), OWNER)} does not exist`,
      ]);
    });
  });

  it('never throws on an unreadable or vanished pid', () => {
    expect(() => resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: 424242, procRoot })).not.toThrow();
    expect(() => resolveSessionConfigDir({ ownerId: OWNER, home, pidHint: -1, procRoot })).not.toThrow();
  });
});
