import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordGateRun,
  recordStandingReds,
  readRunHeartbeats,
  readObservations,
  pruneObservations,
  verdictObservesCompleteStandingSet,
  COMPLETE_STANDING_SET_VERDICTS,
} from '../../../../scripts/lib/tsc-red-observations.mjs';
import { unwritablePath } from '../testing/unwritable-path';

const NOW = 1_700_000_000_000;
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsc-red-beats-'));
  path = join(dir, 'store.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verdictObservesCompleteStandingSet — the soundness boundary', () => {
  it('admits exactly the ok verdicts and rejects every fail verdict', () => {
    for (const v of ['ok', 'ok-below', 'ok-peer-drift', 'ok-ratchet']) {
      expect(verdictObservesCompleteStandingSet(v)).toBe(true);
    }
    for (const v of ['fail-syntax', 'fail-regressed', 'fail-attributed', 'fail-new-file']) {
      expect(verdictObservesCompleteStandingSet(v)).toBe(false);
    }
  });

  it('rejects an UNKNOWN verdict rather than admitting it', () => {
    // This is why the list is an allow-list and not `!startsWith('fail-')`. A verdict nobody
    // has classified must read as "we do not know what this run observed" — admitting it by
    // default is how a future gate change silently starts manufacturing false clean evidence.
    expect(verdictObservesCompleteStandingSet('ok-something-invented-later')).toBe(false);
    expect(verdictObservesCompleteStandingSet(undefined)).toBe(false);
    expect(COMPLETE_STANDING_SET_VERDICTS).toHaveLength(4);
  });
});

describe('recordGateRun', () => {
  it('appends a heartbeat on an ok verdict and reads it back', () => {
    expect(recordGateRun({ verdict: 'ok', project: 'operator-core', path, nowMs: NOW })).toMatchObject({
      ok: true,
      written: 1,
    });
    const beats = readRunHeartbeats({ path, nowMs: NOW });
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ project: 'operator-core', verdict: 'ok', standingCount: 0 });
    expect(beats[0].ts).toBe(Math.floor(NOW / 1000));
  });

  it('writes NOTHING on a fail verdict — that run never knew the standing set', () => {
    // The whole inference downstream is "a run completed and did not re-sight the file". A
    // fail-* run exits before the standing set is recorded, so a heartbeat from one would
    // assert clean-ness about a file it may well have just seen red.
    const r = recordGateRun({ verdict: 'fail-regressed', project: 'operator-core', path, nowMs: NOW });
    expect(r).toMatchObject({ ok: true, written: 0, skipped: 'incomplete-standing-set' });
    expect(readRunHeartbeats({ path, nowMs: NOW })).toEqual([]);
  });

  it('never throws on an unwritable path — the gate hot path must be unaffected', () => {
    // NEVER a hand-written /proc/… literal here: recursive mkdir on a non-existent procfs
    // path ping-pongs forever in Node and hangs vitest COLLECTION with zero output
    // (EI-19369372064589484). The shared fixture fails ENOTDIR immediately.
    const r = recordGateRun({ verdict: 'ok', path: unwritablePath('store.jsonl'), nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
  });
});

describe('heartbeats and observations share one store without contaminating each other', () => {
  it('readObservations never returns a heartbeat', () => {
    recordStandingReds({ entries: [{ file: 'a.ts', current: 2 }], path, nowMs: NOW });
    recordGateRun({ verdict: 'ok', path, nowMs: NOW });
    const obs = readObservations({ path, nowMs: NOW });
    expect(obs).toHaveLength(1);
    expect(obs[0].file).toBe('a.ts');
  });

  it('pruneObservations PRESERVES heartbeats', () => {
    // Regression guard. The prune rewrote the file from readObservations alone, which drops
    // every heartbeat — and nothing would have failed: the resolution path would simply have
    // found no evidence, forever, and looked like it was working correctly while retracting
    // nothing. A silent-permanent-noop is exactly the failure a test has to pin.
    recordStandingReds({ entries: [{ file: 'a.ts', current: 2 }], path, nowMs: NOW });
    recordGateRun({ verdict: 'ok', project: 'operator-core', path, nowMs: NOW });

    const pruned = pruneObservations({ path, nowMs: NOW });
    expect(pruned).toMatchObject({ ok: true, kept: 1, keptRuns: 1 });
    expect(readRunHeartbeats({ path, nowMs: NOW })).toHaveLength(1);
    expect(readObservations({ path, nowMs: NOW })).toHaveLength(1);
    // and the file is still one-record-per-line JSONL
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('drops heartbeats past retention, like observations', () => {
    recordGateRun({ verdict: 'ok', path, nowMs: NOW - 7 * 60 * 60 * 1000 });
    recordGateRun({ verdict: 'ok', path, nowMs: NOW });
    expect(readRunHeartbeats({ path, nowMs: NOW })).toHaveLength(1);
  });
});
