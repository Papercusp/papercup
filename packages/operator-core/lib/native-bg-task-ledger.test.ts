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
 * `hasOpenWriter` is injected throughout: the rule under test is the SELECTION,
 * not /proc. The one test that does touch the real scanner asserts only its
 * fail-soft contract, never a live pid.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNativeBgLedger,
  selectLiveNativeBgTasks,
  readLiveNativeBgTasks,
  renderNativeBgTaskWarning,
  openWriterPids,
  NATIVE_BG_TRACK_MAX_AGE_MS,
  type NativeBgTaskRecord,
} from './native-bg-task-ledger';

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
  it('a MISSING ledger is a clean empty, not degraded (no bg job was ever launched)', () => {
    const r = readLiveNativeBgTasks({
      sid: SID,
      nowMs: NOW,
      ledgerPath: join(tmpdir(), 'wi5936-does-not-exist-' + Math.random() + '.json'),
      hasOpenWriter: alive,
    });
    expect(r).toEqual({ live: [], unattributed: [], degraded: false });
  });

  it('an UNPARSEABLE ledger reports degraded — "not measured" must not read as "nothing live"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi5936-'));
    try {
      const p = join(dir, 'ledger.json');
      writeFileSync(p, '{ this is not json');
      const r = readLiveNativeBgTasks({ sid: SID, nowMs: NOW, ledgerPath: p, hasOpenWriter: alive });
      expect(r.degraded).toBe(true);
      expect(r.live).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a real on-disk ledger in the exact shape the python hook writes', () => {
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
      const r = readLiveNativeBgTasks({ sid: SID, nowMs: NOW, ledgerPath: p, hasOpenWriter: alive });
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

describe('openWriterPids (real scanner — fail-soft contract only)', () => {
  it('returns [] for a path nothing can hold open, and never throws', () => {
    expect(openWriterPids('/tmp/wi5936-nothing-holds-this-' + Math.random())).toEqual([]);
  });

  it('returns [] rather than throwing when the proc root does not exist', () => {
    expect(openWriterPids('/tmp/x', '/nonexistent-proc-root')).toEqual([]);
  });
});
