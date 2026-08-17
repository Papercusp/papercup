/**
 * journal-window-diagnosis.test.ts — WI-7133.
 *
 * journalctl parses `--since`/`--until` in the host's LOCAL time while every
 * papercusp surface reports UTC. On a UTC-4 box, pasting a UTC stamp into `since`
 * queries a window ~4h in the FUTURE, which journalctl answers with a clean exit
 * and zero lines — indistinguishable from "that event was never logged". During a
 * live fleet-death investigation that empty result was read as confirmation of a
 * cause that was already wrong; the real window held the whole story.
 *
 * The subject is `readJournal`'s `windowOutsideJournal` field: an empty result
 * that explains its own emptiness.
 *
 * ⚠ The rule these tests exist to pin is NOT "always diagnose". It is *never
 * diagnose unless it is provable* — a false "your timezone is wrong" misdirects
 * exactly as badly as the silence it replaces. So every un-provable case below
 * asserts NULL, and those are the tests that matter most.
 */
import { describe, it, expect } from 'vitest';
import { readJournal, type JournalExec, type WindowResolver } from './journal-read';

const NEWEST_MS = Date.parse('2026-08-16T21:35:07.000Z');
const PROBE_MARKER = '--output-fields=__REALTIME_TIMESTAMP,MESSAGE';

/** journalctl's own record shape, as the newest-entry probe would receive it. */
function newestEntryStdout(atMs: number): string {
  return JSON.stringify({
    __REALTIME_TIMESTAMP: String(atMs * 1000),
    PRIORITY: '6',
    MESSAGE: 'the newest line in the journal',
  });
}

/**
 * Main query returns nothing; the unfiltered newest-entry probe returns a record.
 * Distinguished by the probe's own `--output-fields`, so the fake cannot drift
 * from the real call shape without this test noticing.
 */
function execEmptyWithNewest(atMs: number | null): JournalExec {
  return async (args) => {
    if (args.includes(PROBE_MARKER)) {
      return { stdout: atMs === null ? '' : newestEntryStdout(atMs) };
    }
    return { stdout: '' };
  };
}

const noUnknownUnits = async () => [];
const resolvesTo = (ms: number | null): WindowResolver => async () => ms;

describe('readJournal — an empty window explains itself (WI-7133)', () => {
  it('DIAGNOSES a window that resolves AFTER the newest record', async () => {
    // The exact trap: a UTC stamp pasted into a local-time parser, landing 4h ahead.
    const sinceMs = NEWEST_MS + 4 * 3_600_000;
    const out = await readJournal(
      { units: ['papercup-bg-host.service'], since: '2026-08-16 21:35:07' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(sinceMs),
    );

    expect(out.entries).toEqual([]);
    expect(out.journalError).toBeNull(); // a CLEAN read — that is what makes it dangerous
    expect(out.windowOutsideJournal).not.toBeNull();
    expect(out.windowOutsideJournal!.aheadByMs).toBe(4 * 3_600_000);
    expect(out.windowOutsideJournal!.newestEntryUtc).toBe('2026-08-16T21:35:07.000Z');
    expect(out.windowOutsideJournal!.resolvedSinceUtc).toBe(new Date(sinceMs).toISOString());
    // The hint must name the CAUSE and the FIX, not merely restate the emptiness.
    expect(out.windowOutsideJournal!.hint).toMatch(/LOCAL/);
    expect(out.windowOutsideJournal!.hint).toMatch(/relative window/i);
  });

  it('CALIBRATION: says nothing when the window sits INSIDE the journal', async () => {
    // Without this control, an implementation that diagnosed unconditionally would
    // pass the test above and be worse than no feature at all.
    const out = await readJournal(
      { units: ['a.service'], since: '-30 min' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(NEWEST_MS - 30 * 60_000),
    );
    expect(out.entries).toEqual([]);
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the window resolves EXACTLY to the newest record', async () => {
    // Boundary: equal is inside, not after. An off-by-one here would fire the
    // diagnosis on a perfectly legitimate `--since <newest>` read.
    const out = await readJournal(
      { units: ['a.service'], since: 'whatever' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(NEWEST_MS),
    );
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the window cannot be resolved', async () => {
    // No systemd-analyze, or a spec it will not parse. Reporting nothing is the
    // required behaviour — the same rule unitIsUnknownTo follows.
    const out = await readJournal(
      { units: ['a.service'], since: 'gibberish' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(null),
    );
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the journal has no records to compare against', async () => {
    // An empty journal cannot prove a window is "past the end" of anything.
    const out = await readJournal(
      { units: ['a.service'], since: 'whenever' },
      execEmptyWithNewest(null),
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 4 * 3_600_000),
    );
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the read actually FAILED — a failure is not a clean window', async () => {
    // journalError already carries the meaning here; adding a window diagnosis on
    // top would invite fixing the timezone when the real problem was a timeout.
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    };
    const out = await readJournal(
      { units: ['a.service'], since: 'whenever' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 4 * 3_600_000),
    );
    expect(out.journalError).not.toBeNull();
    expect(out.matched).toBeNull();
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the read RETURNED rows, however far ahead the window parsed', async () => {
    // The field is only ever about explaining an EMPTY result.
    const exec: JournalExec = async (args) => {
      if (args.includes(PROBE_MARKER)) return { stdout: newestEntryStdout(NEWEST_MS) };
      return { stdout: newestEntryStdout(NEWEST_MS) };
    };
    const out = await readJournal(
      { units: ['a.service'], since: 'whenever' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 4 * 3_600_000),
    );
    expect(out.entries.length).toBe(1);
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('the newest-entry probe requests MESSAGE, or it would silently never fire', async () => {
    // Regression guard for a bug in the FIRST draft of this feature: the probe
    // asked for __REALTIME_TIMESTAMP alone, but parseJournalJson DROPS any record
    // whose MESSAGE will not decode — so every record parsed to nothing and the
    // diagnosis could never fire. That failure mode is invisible (a feature that
    // never triggers looks exactly like a window that is always fine), so the call
    // shape itself is pinned here rather than left to the other tests to imply.
    const seen: string[][] = [];
    const exec: JournalExec = async (args) => {
      seen.push(args);
      if (args.includes(PROBE_MARKER)) return { stdout: newestEntryStdout(NEWEST_MS) };
      return { stdout: '' };
    };
    await readJournal(
      { units: ['a.service'], since: 'whenever' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 1000),
    );
    // Select by the probe's OWN output-fields spec. Matching on '-n' or a bare
    // '--output-fields=' prefix instead picks up the MAIN query, which carries both
    // — and then the -u assertion below passes/fails for the wrong reason.
    const probe = seen.find((a) => a.includes(PROBE_MARKER));
    expect(probe).toBeDefined();
    expect(seen.length).toBeGreaterThan(1); // main query AND probe both ran
    expect(probe!.join(' ')).toContain('MESSAGE');
    // and it must NOT be narrowed by the caller's unit filter, or an empty unit
    // would masquerade as an empty journal
    expect(probe).not.toContain('-u');
  });
});
