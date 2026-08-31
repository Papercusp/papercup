/**
 * tsc-red-observations.test.ts — EI-19342686127995790.
 *
 * The unit under test decides which committed new-file tsc reds have persisted long enough
 * to be considered OWNERLESS and therefore worth filing. Getting it wrong is expensive in
 * both directions: too eager and it manufactures work-items for reds that fix themselves
 * (measured 2026-08-02: 14 errors across 5 files → 1, unaided, in ~15 minutes), too lazy
 * and it re-creates the silent-log problem it exists to solve.
 *
 * NOTE ON CONTROLS. Nearly every assertion here is a NEGATIVE — "this did not qualify" —
 * and a negative passes just as happily against a function that qualifies NOTHING, or one
 * that was never called. So each rejection case below is paired with a positive that
 * differs in exactly ONE dimension: same fixture, one field moved across the threshold.
 * A blanket-reject implementation fails the paired positive; a blanket-accept one fails
 * the rejection. Neither can pass this file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Types come from the hand-written sibling `scripts/lib/tsc-red-observations.d.mts`.
// This import previously carried a `// @ts-ignore — pure JS guard script, no .d.ts`,
// which suppressed NOTHING: TS reports TS7016 at the module-specifier line, not at the
// `import` keyword, and @ts-ignore only covers the line directly after it. The result
// was 7 committed type errors that read as handled (EI-19365056012137849).
import {
  recordStandingReds,
  readObservations,
  selectDwelledReds,
  pruneObservations,
  DWELL_SEC,
  STALE_SEC,
  RETENTION_SEC,
} from '../../../../scripts/lib/tsc-red-observations.mjs';

const NOW = 1_800_000_000_000; // fixed clock, ms
const nowSec = Math.floor(NOW / 1000);
const dirs: string[] = [];

function tmpStore(): string {
  const d = mkdtempSync(join(tmpdir(), 'tsc-red-obs-'));
  dirs.push(d);
  return join(d, 'reds.jsonl');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** One observation record, `agoSec` seconds before NOW. */
const obs = (file: string, agoSec: number, count = 1) => ({
  ts: nowSec - agoSec,
  file,
  count,
  project: 'operator-core',
});

describe('recordStandingReds — the hot path', () => {
  it('appends one JSONL line per standing red', () => {
    const path = tmpStore();
    const r = recordStandingReds({
      entries: [
        { file: 'a.ts', current: 3 },
        { file: 'b.ts', current: 1 },
      ],
      path,
      nowMs: NOW,
      project: 'operator-core',
    });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(2);

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ file: 'a.ts', count: 3, project: 'operator-core' });
  });

  it('APPENDS rather than truncating — concurrent gate runs must not erase each other', () => {
    // ~9 lint-tsc compiles/hour run concurrently on this box. A truncating write would
    // leave the store holding whichever run finished last, destroying the very history
    // the dwell decision is computed from.
    const path = tmpStore();
    recordStandingReds({ entries: [{ file: 'a.ts', current: 1 }], path, nowMs: NOW });
    recordStandingReds({ entries: [{ file: 'b.ts', current: 1 }], path, nowMs: NOW });
    expect(readFileSync(path, 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('NEVER THROWS on an unwritable path — the gate verdict must not depend on it', () => {
    // The whole design rests on this: tsc-baseline-gate.mjs is shared hot infrastructure,
    // and TSC_EXIT / "✓ tsc-clean" must keep meaning exactly what they mean today.
    // ⚠ The path MUST fail fast. `/proc/<anything>/reds.jsonl` — the obvious choice, and
    // what this test used first — makes `mkdirSync(dirname, { recursive: true })` HANG
    // FOREVER on this kernel rather than returning EACCES. That wedged the whole file
    // before vitest printed a single line, so it read as queue contention / infra flake
    // rather than a test bug, and cost two full re-runs to localize. `/dev/null/...`
    // throws ENOTDIR in 0ms because the first path component is not a directory.
    const r = recordStandingReds({
      entries: [{ file: 'a.ts', current: 1 }],
      path: '/dev/null/definitely-not-writable/reds.jsonl',
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('writes nothing for an empty set, and creates no file', () => {
    const path = tmpStore();
    expect(recordStandingReds({ entries: [], path, nowMs: NOW })).toMatchObject({ ok: true, written: 0 });
    expect(existsSync(path)).toBe(false);
  });
});

describe('readObservations', () => {
  it('skips a corrupt line instead of failing the whole read', () => {
    // Concurrent appenders can in principle interleave a partial write. One bad line must
    // not blind the sweeper to every good one.
    const path = tmpStore();
    writeFileSync(path, `${JSON.stringify(obs('a.ts', 10))}\n{ this is not json\n${JSON.stringify(obs('b.ts', 10))}\n`);
    const got = readObservations({ path, nowMs: NOW });
    expect(got.map((o) => o.file).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('drops observations past retention, and keeps ones inside it', () => {
    // Paired directions in one case: the same fixture shape either side of the boundary.
    const path = tmpStore();
    writeFileSync(path, `${JSON.stringify(obs('old.ts', RETENTION_SEC + 60))}\n${JSON.stringify(obs('fresh.ts', 60))}\n`);
    expect(readObservations({ path, nowMs: NOW }).map((o) => o.file)).toEqual(['fresh.ts']);
  });

  it('returns empty for a missing store rather than throwing', () => {
    expect(readObservations({ path: join(tmpdir(), 'nope-does-not-exist.jsonl'), nowMs: NOW })).toEqual([]);
  });
});

describe('selectDwelledReds — the decision', () => {
  it('QUALIFIES a red observed across more than the dwell window', () => {
    // The positive control every rejection below is measured against.
    const got = selectDwelledReds(
      [obs('stale-red.ts', DWELL_SEC + 600), obs('stale-red.ts', 300)],
      { nowMs: NOW },
    );
    expect(got.map((r) => r.file)).toEqual(['stale-red.ts']);
    expect(got[0].sightings).toBe(2);
    expect(got[0].spanSec).toBeGreaterThanOrEqual(DWELL_SEC);
  });

  it('REJECTS a red whose span is under the dwell window — this is the self-healing majority', () => {
    // Differs from the positive above in ONE dimension: the span. 4 of 5 reds measured on
    // 2026-08-02 were fixed inside 15 minutes; filing those is the failure mode.
    const got = selectDwelledReds(
      [obs('quick.ts', DWELL_SEC - 600), obs('quick.ts', 60)],
      { nowMs: NOW },
    );
    expect(got).toEqual([]);
  });

  it('REJECTS a single sighting however old — existence is not persistence', () => {
    // One observation cannot distinguish "still red for an hour" from "seen once, an hour ago".
    expect(selectDwelledReds([obs('once.ts', DWELL_SEC * 4)], { nowMs: NOW })).toEqual([]);
    // CONTROL: the identical fixture plus one recent sighting DOES qualify, so the rejection
    // above is attributable to the sighting count and nothing else.
    expect(
      selectDwelledReds([obs('once.ts', DWELL_SEC * 4), obs('once.ts', 60)], { nowMs: NOW }).map((r) => r.file),
    ).toEqual(['once.ts']);
  });

  it('REJECTS a red not seen recently — it was fixed, and its history must not outlive it', () => {
    // Without the staleness ceiling, a red fixed an hour ago still has a >dwell span forever
    // and would be filed long after someone fixed it.
    const got = selectDwelledReds(
      [obs('fixed.ts', DWELL_SEC + STALE_SEC + 1200), obs('fixed.ts', STALE_SEC + 600)],
      { nowMs: NOW },
    );
    expect(got).toEqual([]);
    // CONTROL: same two-sighting shape, same span, only the tail moved inside the window.
    expect(
      selectDwelledReds([obs('live.ts', DWELL_SEC + 600), obs('live.ts', 60)], { nowMs: NOW }).map((r) => r.file),
    ).toEqual(['live.ts']);
  });

  it('reports the LATEST error count, not the first — a shrinking red is being worked', () => {
    // typed-mock.ts went 0→5 then 0→1 within 15 minutes. The direction of travel is the
    // signal a triager needs, so the count must be the most recent one.
    const got = selectDwelledReds(
      [obs('shrinking.ts', DWELL_SEC + 600, 5), obs('shrinking.ts', 60, 1)],
      { nowMs: NOW },
    );
    expect(got[0].latestCount).toBe(1);
  });

  it('orders longest-standing first — that is the triage order', () => {
    const got = selectDwelledReds(
      [
        obs('newer.ts', DWELL_SEC + 300),
        obs('newer.ts', 60),
        obs('older.ts', DWELL_SEC * 3),
        obs('older.ts', 60),
      ],
      { nowMs: NOW },
    );
    expect(got.map((r) => r.file)).toEqual(['older.ts', 'newer.ts']);
  });

  it('returns nothing for no observations', () => {
    expect(selectDwelledReds([], { nowMs: NOW })).toEqual([]);
  });
});

describe('pruneObservations', () => {
  it('keeps in-retention records and drops the rest', () => {
    const path = tmpStore();
    writeFileSync(path, `${JSON.stringify(obs('old.ts', RETENTION_SEC + 60))}\n${JSON.stringify(obs('fresh.ts', 60))}\n`);
    expect(pruneObservations({ path, nowMs: NOW })).toMatchObject({ ok: true, kept: 1 });
    expect(readFileSync(path, 'utf-8')).toContain('fresh.ts');
    expect(readFileSync(path, 'utf-8')).not.toContain('old.ts');
  });
});

describe('the thresholds are internally consistent', () => {
  it('dwell exceeds the landing-race window it is deliberately distinct from', () => {
    // tsc-baseline-gate's LANDING_RACE_WINDOW_SEC is 20min and answers a DIFFERENT question
    // ("might this be half a multi-file change still landing?"). A red can clear that window
    // and still be actively owned — delegated-spawn-honor.test.ts was exactly that at 22min —
    // so dwell must be strictly longer or this collapses into the wrong question.
    expect(DWELL_SEC).toBeGreaterThan(20 * 60);
  });

  it('retention outlives dwell plus staleness, or a qualifying red is pruned before it can qualify', () => {
    expect(RETENTION_SEC).toBeGreaterThan(DWELL_SEC + STALE_SEC);
  });
});

/**
 * ROOT SCOPING — EI-21985631427355996.
 *
 * The store path is process-global but `file` is only ever relative to the tree the gate ran
 * from, so an observation is meaningless outside that tree. `lint-tsc.test.ts` drives the gate
 * against a synthetic `mkdtempSync` root; before this scoping, one run of its `old-peer.ts`
 * case appended `lib/old-peer.ts` — a path that has never existed in this repository — into
 * the fleet's live store, where 15 records accumulated over 172 minutes and the sweep filed a
 * work-item for it.
 *
 * CONTROLS, per this file's standing discipline. The filter must act on POSITIVE evidence of
 * a foreign tree and on nothing else, so each rejection is paired with an admission differing
 * in exactly one dimension. An implementation that drops unstamped lines fails `admits an
 * UNSTAMPED line`; one that never filters fails `drops a line stamped with a DIFFERENT root`;
 * one that filters when the reader named no root fails `no root argument disables the filter`.
 */
describe('readObservations — root scoping', () => {
  const stamped = (file: string, root?: string) => ({
    ts: nowSec - 60,
    file,
    count: 1,
    project: 'operator-core',
    ...(root ? { root } : {}),
  });

  const write = (recs: object[]) => {
    const path = tmpStore();
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return path;
  };

  it('drops a line stamped with a DIFFERENT root', () => {
    const path = write([stamped('lib/old-peer.ts', '/tmp/tsc-gate-unchanged-abc123')]);
    expect(readObservations({ path, nowMs: NOW, root: '/repo' })).toEqual([]);
  });

  it('keeps a line stamped with the SAME root — the paired positive', () => {
    const path = write([stamped('lib/real.ts', '/repo')]);
    expect(readObservations({ path, nowMs: NOW, root: '/repo' }).map((o) => o.file)).toEqual(['lib/real.ts']);
  });

  it('admits an UNSTAMPED line: no stamp means UNKNOWN, and unknown is not foreign', () => {
    // Legacy lines, and any caller that cannot name its root, must keep working. A reader
    // that discarded unknowns would silently blind the sweeper to every pre-existing record.
    const path = write([stamped('lib/legacy.ts')]);
    expect(readObservations({ path, nowMs: NOW, root: '/repo' }).map((o) => o.file)).toEqual(['lib/legacy.ts']);
  });

  it('no root argument disables the filter entirely', () => {
    const path = write([stamped('lib/a.ts', '/one'), stamped('lib/b.ts', '/two'), stamped('lib/c.ts')]);
    expect(
      readObservations({ path, nowMs: NOW })
        .map((o) => o.file)
        .sort(),
    ).toEqual(['lib/a.ts', 'lib/b.ts', 'lib/c.ts']);
  });

  it('round-trips: what recordStandingReds stamps is what the same root reads back', () => {
    const path = tmpStore();
    recordStandingReds({ entries: [{ file: 'lib/x.ts', current: 2 }], path, nowMs: NOW, project: 'operator-core', root: '/repo' });
    recordStandingReds({ entries: [{ file: 'lib/fixture.ts', current: 1 }], path, nowMs: NOW, project: 'test', root: '/tmp/fixture' });
    expect(readObservations({ path, nowMs: NOW, root: '/repo' }).map((o) => o.file)).toEqual(['lib/x.ts']);
    expect(readObservations({ path, nowMs: NOW, root: '/tmp/fixture' }).map((o) => o.file)).toEqual(['lib/fixture.ts']);
  });

  it('omitting root on the WRITE side stamps nothing, so every reader still admits it', () => {
    const path = tmpStore();
    recordStandingReds({ entries: [{ file: 'lib/y.ts', current: 1 }], path, nowMs: NOW, project: 'operator-core' });
    expect(readFileSync(path, 'utf-8')).not.toContain('"root"');
    expect(readObservations({ path, nowMs: NOW, root: '/any-root-at-all' }).map((o) => o.file)).toEqual(['lib/y.ts']);
  });
});
