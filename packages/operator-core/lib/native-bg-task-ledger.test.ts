/**
 * native-bg-task-ledger.test.ts — WI-5936 / EI-16611.
 *
 * The subject decides whether a carry-respawn is about to silently kill a
 * session's native background Bash jobs. Two properties carry the whole
 * feature, and each has a specific way of failing SILENTLY — which is what
 * these tests are shaped around rather than round-tripping the happy path:
 *
 *   1. UNIT AGREEMENT with the writer. The python hook writes `started_at` via
 *      `time.time()` — SECONDS. Read as milliseconds, every record dates to
 *      1970, every age check passes, and the feature looks like it works
 *      forever while silently reporting on nothing.
 *   2. LIVENESS IS EVIDENCE, NOT AGE. A launch is not a running job. The
 *      liveness decision must come from an open-fd observation, so a finished
 *      job is never reported as about to be killed.
 *
 * `hasOpenWriter` is injected for the SELECTION tests: the rule under test there
 * is the selection, not /proc. The scanner itself is exercised against a FAKE
 * proc root (`<pid>/fd/<n>` symlinks in a tmpdir) — WI-10005283 — and the real
 * /proc is touched only for the fail-soft contract, never a live pid.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNativeBgLedger,
  selectLiveNativeBgTasks,
  candidateNativeBgRecords,
  readLiveNativeBgTasks,
  renderNativeBgTaskWarning,
  openWriterPidsMany,
  NATIVE_BG_TRACK_MAX_AGE_MS,
  type NativeBgTaskRecord,
} from './native-bg-task-ledger';

/** A fake /proc: `holders` maps pid -> the paths its fds point at. */
function fakeProc(holders: Record<string, string[]>, extraEntries: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'wi10005283-proc-'));
  for (const [pid, targets] of Object.entries(holders)) {
    const fdDir = join(root, pid, 'fd');
    mkdirSync(fdDir, { recursive: true });
    targets.forEach((t, i) => symlinkSync(t, join(fdDir, String(i))));
  }
  for (const e of extraEntries) mkdirSync(join(root, e), { recursive: true });
  return root;
}

const SID = 'su-2bbbd89b-0208-4b79-8d3b-79cb354c4f61';
const NOW = 1_786_573_000_000;
const alive = () => ['4242'];
const dead = () => [];

function rec(over: Partial<NativeBgTaskRecord> = {}): NativeBgTaskRecord {
  return { path: '/tmp/a.log', startedAtMs: NOW - 60_000, sid: SID, ...over };
}

describe('parseNativeBgLedger', () => {
  it('reads started_at as SECONDS and converts to ms (the writer uses time.time())', () => {
    const startedSec = NOW / 1000 - 30;
    const out = parseNativeBgLedger(
      JSON.stringify({ '/tmp/x.log': { started_at: startedSec, cmd: 'c', sid: SID } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].startedAtMs).toBe(startedSec * 1000);
    // The failure this pins: reading the value as ms would put it in 1970, which
    // is >>2h before NOW, so the age filter would silently drop every record.
    expect(NOW - out[0].startedAtMs).toBeLessThan(NATIVE_BG_TRACK_MAX_AGE_MS);
  });

  it('keeps good records when a sibling record is malformed', () => {
    const out = parseNativeBgLedger(
      JSON.stringify({
        '/tmp/bad.log': { cmd: 'no timestamp' },
        '/tmp/alsobad.log': 'not an object',
        '/tmp/good.log': { started_at: NOW / 1000, cmd: 'ok', sid: SID },
      }),
    );
    expect(out.map((r) => r.path)).toEqual(['/tmp/good.log']);
  });

  it('returns [] for invalid JSON, an array, or null (never throws)', () => {
    expect(parseNativeBgLedger('{not json')).toEqual([]);
    expect(parseNativeBgLedger('[]')).toEqual([]);
    expect(parseNativeBgLedger('null')).toEqual([]);
  });

  it('omits sid when the record predates the stamp, rather than inventing one', () => {
    const out = parseNativeBgLedger(
      JSON.stringify({ '/tmp/old.log': { started_at: NOW / 1000, cmd: 'legacy' } }),
    );
    expect(out[0].sid).toBeUndefined();
  });

  it('never carries legacy command text across the persistence boundary', () => {
    const secret = 'Authorization: Bearer should-never-surface';
    const out = parseNativeBgLedger(
      JSON.stringify({ '/tmp/old.log': { started_at: NOW / 1000, cmd: secret, sid: SID } }),
    );
    expect(out).toEqual([{ path: '/tmp/old.log', startedAtMs: NOW, sid: SID }]);
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});

describe('selectLiveNativeBgTasks', () => {
  it('reports a live job owned by this session', () => {
    const { live } = selectLiveNativeBgTasks({
      records: [rec()],
      sid: SID,
      nowMs: NOW,
      hasOpenWriter: alive,
    });
    expect(live).toHaveLength(1);
    expect(live[0].pids).toEqual(['4242']);
    expect(live[0].ageSec).toBe(60);
  });

  it('does NOT report a job with no open writer — a launch is not a running job', () => {
    const { live, unattributed } = selectLiveNativeBgTasks({
      records: [rec()],
      sid: SID,
      nowMs: NOW,
      hasOpenWriter: dead,
    });
    expect(live).toEqual([]);
    expect(unattributed).toEqual([]);
  });

  it("ignores another session's live job — this cut cannot kill it", () => {
    const { live, unattributed } = selectLiveNativeBgTasks({
      records: [rec({ sid: 'su-someone-else' })],
      sid: SID,
      nowMs: NOW,
      hasOpenWriter: alive,
    });
    expect(live).toEqual([]);
    expect(unattributed).toEqual([]);
  });

  it('reports an unstamped live job as unattributed — neither claimed nor dropped', () => {
    const { live, unattributed } = selectLiveNativeBgTasks({
      records: [rec({ sid: undefined })],
      sid: SID,
      nowMs: NOW,
      hasOpenWriter: alive,
    });
    expect(live).toEqual([]);
    expect(unattributed).toHaveLength(1);
  });

  it('drops records past the 2h prune window even if something still holds the fd', () => {
    const { live } = selectLiveNativeBgTasks({
      records: [rec({ startedAtMs: NOW - NATIVE_BG_TRACK_MAX_AGE_MS - 1 })],
      sid: SID,
      nowMs: NOW,
      hasOpenWriter: alive,
    });
    expect(live).toEqual([]);
  });

  it('sorts oldest-first so the longest-running job is named first', () => {
    const { live } = selectLiveNativeBgTasks({
      records: [
        rec({ path: '/tmp/new.log', startedAtMs: NOW - 10_000 }),
        rec({ path: '/tmp/old.log', startedAtMs: NOW - 900_000 }),
      ],
      sid: SID,
      nowMs: NOW,
      hasOpenWriter: alive,
    });
    expect(live.map((t) => t.path)).toEqual(['/tmp/old.log', '/tmp/new.log']);
  });
});

describe('readLiveNativeBgTasks', () => {
  it('a MISSING ledger is a clean empty, not degraded (no bg job was ever launched)', async () => {
    const r = await readLiveNativeBgTasks({
      sid: SID,
      nowMs: NOW,
      ledgerPath: join(tmpdir(), 'wi5936-does-not-exist-' + Math.random() + '.json'),
      hasOpenWriter: alive,
    });
    expect(r).toEqual({ live: [], unattributed: [], degraded: false });
  });

  it('an UNPARSEABLE ledger reports degraded — "not measured" must not read as "nothing live"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi5936-'));
    try {
      const p = join(dir, 'ledger.json');
      writeFileSync(p, '{ this is not json');
      const r = await readLiveNativeBgTasks({ sid: SID, nowMs: NOW, ledgerPath: p, hasOpenWriter: alive });
      expect(r.degraded).toBe(true);
      expect(r.live).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without an injected seam, decides liveness from ONE /proc scan of the candidate paths (WI-10005283)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi10005283-'));
    const proc = fakeProc({ '11': ['/tmp/mine.log'], '12': ['/tmp/anon.log', '/dev/null'] }, ['self']);
    try {
      const p = join(dir, 'ledger.json');
      writeFileSync(
        p,
        JSON.stringify({
          '/tmp/mine.log': { started_at: NOW / 1000 - 30, sid: SID },
          '/tmp/anon.log': { started_at: NOW / 1000 - 40 },
          '/tmp/done.log': { started_at: NOW / 1000 - 50, sid: SID }, // nobody holds it
          '/tmp/theirs.log': { started_at: NOW / 1000 - 60, sid: 'su-someone-else' },
        }),
      );
      const r = await readLiveNativeBgTasks({ sid: SID, nowMs: NOW, ledgerPath: p, procRoot: proc });
      expect(r.degraded).toBe(false);
      expect(r.live.map((t) => [t.path, t.pids])).toEqual([['/tmp/mine.log', ['11']]]);
      expect(r.unattributed.map((t) => [t.path, t.pids])).toEqual([['/tmp/anon.log', ['12']]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(proc, { recursive: true, force: true });
    }
  });

  it('reports degraded when the scan deadline cuts the walk short — a partial scan is not an all-clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi10005283-'));
    const proc = fakeProc({ '21': ['/tmp/mine.log'] });
    try {
      const p = join(dir, 'ledger.json');
      writeFileSync(p, JSON.stringify({ '/tmp/mine.log': { started_at: NOW / 1000 - 30, sid: SID } }));
      const r = await readLiveNativeBgTasks({
        sid: SID,
        nowMs: NOW,
        ledgerPath: p,
        procRoot: proc,
        scanDeadlineMs: -1, // already expired: no pid gets visited
      });
      expect(r.degraded).toBe(true);
      expect(r.live).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(proc, { recursive: true, force: true });
    }
  });

  it('reads a real on-disk ledger in the exact shape the python hook writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi5936-'));
    try {
      const p = join(dir, 'ledger.json');
      // Byte-shape copied from a live hook run, including seconds + sid.
      writeFileSync(
        p,
        JSON.stringify({
          '/tmp/wi5936.log': {
            started_at: NOW / 1000 - 120,
            sid: SID,
          },
        }),
      );
      const r = await readLiveNativeBgTasks({ sid: SID, nowMs: NOW, ledgerPath: p, hasOpenWriter: alive });
      expect(r.degraded).toBe(false);
      expect(r.live).toHaveLength(1);
      expect(r.live[0].ageSec).toBe(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderNativeBgTaskWarning', () => {
  it('is EMPTY when nothing is live, so the caller can append it unconditionally', () => {
    expect(renderNativeBgTaskWarning({ live: [], unattributed: [], degraded: false })).toBe('');
  });

  it('names the output path, the age, the pid, and the conversion route', () => {
    const out = renderNativeBgTaskWarning({
      live: [{ ...rec(), ageSec: 300, pids: ['4242'] }],
      unattributed: [],
      degraded: false,
    });
    expect(out).toContain('/tmp/a.log');
    expect(out).toContain('300s');
    expect(out).toContain('4242');
    expect(out).toContain('capability:bash');
    // The honesty clause: only redirecting jobs are tracked, so this is a floor.
    expect(out).toMatch(/FLOOR, not a total/i);
  });

  it('marks an unattributed job so it is never reported as certainly the caller’s', () => {
    const out = renderNativeBgTaskWarning({
      live: [],
      unattributed: [{ ...rec({ sid: undefined }), ageSec: 10, pids: ['7'] }],
      degraded: false,
    });
    expect(out).toContain('unattributed');
  });
});

describe('candidateNativeBgRecords', () => {
  it('keeps young records that are this session’s or unstamped; drops aged and foreign ones', () => {
    const out = candidateNativeBgRecords({
      sid: SID,
      nowMs: NOW,
      records: [
        rec({ path: '/tmp/mine.log' }),
        rec({ path: '/tmp/anon.log', sid: undefined }),
        rec({ path: '/tmp/old.log', startedAtMs: NOW - NATIVE_BG_TRACK_MAX_AGE_MS }),
        rec({ path: '/tmp/theirs.log', sid: 'su-someone-else' }),
      ],
    });
    expect(out.map((r) => r.path)).toEqual(['/tmp/mine.log', '/tmp/anon.log']);
  });
});

describe('openWriterPidsMany (WI-10005283)', () => {
  it('retention mode matches descendants and cwd without matching sibling prefixes', async () => {
    const proc = fakeProc({ '1': ['/tmp/tree/deep/file'], '2': ['/tmp/tree-other/file'], '3': [] });
    symlinkSync('/tmp/tree/nested', join(proc, '3', 'cwd'));
    try {
      const scan = await openWriterPidsMany(['/tmp/tree'], {
        procRoot: proc, descendants: true, includeCwd: true, failClosed: true,
      });
      expect(scan.complete).toBe(true);
      expect(scan.byPath.get('/tmp/tree')).toEqual(['1', '3']);
    } finally { rmSync(proc, { recursive: true, force: true }); }
  });

  it('retention mode refuses a missing proc root and expired scan budget', async () => {
    expect((await openWriterPidsMany(['/tmp/tree'], {
      procRoot: '/nonexistent-proc-root', failClosed: true,
    })).complete).toBe(false);
    const proc = fakeProc({ '1': ['/tmp/tree/file'] });
    try {
      expect((await openWriterPidsMany(['/tmp/tree'], {
        procRoot: proc, failClosed: true, deadlineMs: -1,
      })).complete).toBe(false);
    } finally { rmSync(proc, { recursive: true, force: true }); }
  });

  it('answers every path from ONE pass: all holders per path, sorted, skipping non-pid entries', async () => {
    const proc = fakeProc(
      {
        '300': ['/tmp/a.log', '/tmp/b.log', '/tmp/a.log'], // a duplicate fd must not double-count
        '20': ['/tmp/a.log'],
        '7': ['/dev/null'],
        '8': [], // a process with no fds
      },
      ['self', 'sys'],
    );
    try {
      const scan = await openWriterPidsMany(['/tmp/a.log', '/tmp/b.log', '/tmp/c.log'], { procRoot: proc });
      expect(scan.complete).toBe(true);
      expect(scan.byPath.get('/tmp/a.log')).toEqual(['20', '300']);
      expect(scan.byPath.get('/tmp/b.log')).toEqual(['300']);
      expect(scan.byPath.has('/tmp/c.log')).toBe(false);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });

  it('does not walk /proc at all when there are no candidate paths', async () => {
    const scan = await openWriterPidsMany([], { procRoot: '/nonexistent-proc-root' });
    expect(scan).toEqual({ byPath: new Map(), complete: true });
  });

  it('is an empty, complete answer when the proc root does not exist (non-Linux), never a throw', async () => {
    const scan = await openWriterPidsMany(['/tmp/x'], { procRoot: '/nonexistent-proc-root' });
    expect(scan.byPath.size).toBe(0);
    expect(scan.complete).toBe(true);
  });

  it('never throws on the real /proc for a path nothing can hold open', async () => {
    const scan = await openWriterPidsMany(['/tmp/wi5936-nothing-holds-this-' + Math.random()]);
    expect(scan.byPath.size).toBe(0);
  });

  it('keeps the event loop turning while it walks — the regression this item fixed was a SYNC walk', async () => {
    // A synchronous scanner resolves with ZERO interleaved macrotasks; that is
    // exactly the multi-second main-thread stall seen in session:request-compaction.
    const holders: Record<string, string[]> = {};
    for (let pid = 1000; pid < 1200; pid++) holders[String(pid)] = ['/dev/null', '/dev/zero', '/tmp/x'];
    const proc = fakeProc(holders);
    try {
      let ticks = 0;
      let running = true;
      const spin = (): void => {
        if (!running) return;
        ticks++;
        setImmediate(spin);
      };
      setImmediate(spin);
      const scan = await openWriterPidsMany(['/tmp/wanted.log'], { procRoot: proc });
      running = false;
      expect(scan.complete).toBe(true);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
});
