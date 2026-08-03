/**
 * Tests for the content-lint PROBE (EI-19457795809466683).
 *
 * CALIBRATION DISCIPLINE: every "did not flag" assertion here is paired with a
 * known TRUE POSITIVE on the same detector and the same filename. Without that
 * pairing a probe that always answered "clean" — or one whose detector had gone
 * inert — would pass the whole suite, which is precisely the failure the probe
 * exists to diagnose. The true positive is the real WI-9253 outage shape: a
 * backtick-quoted identifier inside a `--` comment inside a typed sql<T>``
 * template, which is what ended the enclosing template literal and took :3170
 * down on 2026-08-03.
 */
import { describe, it, expect } from 'vitest';
import {
  probeContent,
  probeExitCode,
  formatProbeResult,
  PROBE_EXIT,
  type DetectorVerdict,
} from './probe';
import type { ContentDetector } from './registry';

/** The WI-9253 outage shape — a KNOWN offender. */
const OUTAGE_TEXT = [
  'const rows = await sql<Row[]>`',
  '  -- the `closed_ts` column is null while open',
  '  SELECT id FROM harness_shared.work_items',
  '`;',
].join('\n');

/** Byte-for-byte the same query with the comment rephrased — a KNOWN clean control. */
const CONTROL_TEXT = [
  'const rows = await sql<Row[]>`',
  "  -- the 'closed_ts' column is null while open",
  '  SELECT id FROM harness_shared.work_items',
  '`;',
].join('\n');

const IN_SCOPE_PATH = 'packages/operator-core/lib/watchdog.ts';
const SQL_KEY = 'sql-comment-backtick';

const statusOf = (verdicts: DetectorVerdict[], key: string) =>
  verdicts.find((v) => v.key === key)?.status;

describe('probeContent — calibration pair on the real WI-9253 outage text', () => {
  it('FLAGS the outage text (true positive) — so a permanently-clean probe cannot pass', async () => {
    const result = await probeContent({
      fileName: IN_SCOPE_PATH,
      text: OUTAGE_TEXT,
      only: [SQL_KEY],
    });

    expect(statusOf(result.verdicts, SQL_KEY)).toBe('flagged');
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].message).toMatch(/backtick-quoted identifier inside a SQL comment/);
    expect(result.ranCount).toBe(1);
    expect(probeExitCode(result)).toBe(PROBE_EXIT.FLAGGED);
  });

  it('does NOT flag the control (same query, straight quotes) — so an always-flagging probe cannot pass', async () => {
    const result = await probeContent({
      fileName: IN_SCOPE_PATH,
      text: CONTROL_TEXT,
      only: [SQL_KEY],
    });

    expect(statusOf(result.verdicts, SQL_KEY)).toBe('clean');
    expect(result.flagged).toHaveLength(0);
    expect(result.ranCount).toBe(1);
    expect(probeExitCode(result)).toBe(PROBE_EXIT.CLEAN);
  });
});

describe('probeContent — the filename is an INPUT, not decoration', () => {
  it('reports out-of-scope (not clean) when the path excludes the detector', async () => {
    const result = await probeContent({
      fileName: 'docs/notes.md',
      text: OUTAGE_TEXT,
      only: [SQL_KEY],
    });

    // Same offending bytes as the true-positive case above; only the path differs.
    expect(statusOf(result.verdicts, SQL_KEY)).toBe('out-of-scope');
    expect(result.flagged).toHaveLength(0);
    expect(result.ranCount).toBe(0);
  });

  it('separates out-of-scope from clean — they are different answers demanding different actions', async () => {
    const outOfScope = await probeContent({ fileName: 'docs/x.md', text: OUTAGE_TEXT, only: [SQL_KEY] });
    const clean = await probeContent({ fileName: IN_SCOPE_PATH, text: CONTROL_TEXT, only: [SQL_KEY] });

    expect(statusOf(outOfScope.verdicts, SQL_KEY)).toBe('out-of-scope');
    expect(statusOf(clean.verdicts, SQL_KEY)).toBe('clean');
    // Both have zero hits, but only one of them actually measured anything.
    expect(outOfScope.flagged).toHaveLength(0);
    expect(clean.flagged).toHaveLength(0);
    expect(outOfScope.ranCount).toBe(0);
    expect(clean.ranCount).toBe(1);
  });
});

describe('probeExitCode — a run that measured NOTHING is never reported clean', () => {
  it('exits MISUSE, not CLEAN, when no detector was in scope', async () => {
    const result = await probeContent({ fileName: 'docs/notes.md', text: OUTAGE_TEXT, only: [SQL_KEY] });

    expect(result.ranCount).toBe(0);
    expect(result.flagged).toHaveLength(0);
    // The whole point: zero hits from zero detectors is NOT a pass.
    expect(probeExitCode(result)).toBe(PROBE_EXIT.MISUSE);
    expect(probeExitCode(result)).not.toBe(PROBE_EXIT.CLEAN);
  });

  it('exits MISUSE for an unknown detector key rather than silently probing nothing', async () => {
    const result = await probeContent({
      fileName: IN_SCOPE_PATH,
      text: OUTAGE_TEXT,
      only: ['no-such-detector'],
    });

    expect(result.unknownKeys).toEqual(['no-such-detector']);
    expect(probeExitCode(result)).toBe(PROBE_EXIT.MISUSE);
  });

  it('surfaces a throwing detector as an error, never as "found nothing"', async () => {
    const exploding: ContentDetector = {
      key: 'exploding',
      glob: '**/*.ts',
      matches: () => true,
      detect: () => {
        throw new Error('boom');
      },
      fixerRole: 'content-fixer',
    };

    const result = await probeContent({
      fileName: IN_SCOPE_PATH,
      text: CONTROL_TEXT,
      detectors: [exploding],
    });

    expect(statusOf(result.verdicts, 'exploding')).toBe('error');
    expect(result.flagged).toHaveLength(0);
    expect(probeExitCode(result)).toBe(PROBE_EXIT.MISUSE);
  });

  it('surfaces a throwing SCOPE predicate as an error too', async () => {
    const badScope: ContentDetector = {
      key: 'bad-scope',
      glob: '**/*.ts',
      matches: () => {
        throw new Error('scope boom');
      },
      detect: () => null,
      fixerRole: 'content-fixer',
    };

    const result = await probeContent({ fileName: IN_SCOPE_PATH, text: '', detectors: [badScope] });

    expect(statusOf(result.verdicts, 'bad-scope')).toBe('error');
    expect(probeExitCode(result)).toBe(PROBE_EXIT.MISUSE);
  });
});

describe('probeContent — registry selection', () => {
  it('runs the whole registry by default and reports every detector considered', async () => {
    const result = await probeContent({ fileName: IN_SCOPE_PATH, text: OUTAGE_TEXT });

    // The registry documents that this offender trips the specific detector AND
    // ts-parse (the backtick ends the template, so the file also fails to parse).
    const flaggedKeys = result.flagged.map((f) => f.key);
    expect(flaggedKeys).toContain(SQL_KEY);
    expect(result.verdicts.length).toBeGreaterThan(1);
    expect(result.ranCount).toBeGreaterThan(0);
  });

  it('restricts to the requested detector', async () => {
    const result = await probeContent({
      fileName: IN_SCOPE_PATH,
      text: OUTAGE_TEXT,
      only: [SQL_KEY],
    });

    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].key).toBe(SQL_KEY);
  });
});

describe('formatProbeResult', () => {
  it('warns loudly that NOTHING RAN, and does not call it clean', async () => {
    const result = await probeContent({ fileName: 'docs/notes.md', text: OUTAGE_TEXT, only: [SQL_KEY] });
    const text = formatProbeResult(result);

    expect(text).toMatch(/NOTHING RAN/);
    expect(text).toMatch(/measured NOTHING/);
    expect(text).toMatch(/out of scope/);
  });

  it('states that "did not flag" is not proof the content is fine', async () => {
    const result = await probeContent({ fileName: IN_SCOPE_PATH, text: CONTROL_TEXT, only: [SQL_KEY] });
    const text = formatProbeResult(result);

    expect(text).toMatch(/did not flag/);
    // The WI-9253 ambiguity must be named, not hidden behind a bare "clean".
    expect(text).toMatch(/not proof the content is fine/);
  });

  it('renders the detector message for a hit', async () => {
    const result = await probeContent({ fileName: IN_SCOPE_PATH, text: OUTAGE_TEXT, only: [SQL_KEY] });
    const text = formatProbeResult(result);

    expect(text).toMatch(/FLAGGED/);
    expect(text).toMatch(/SQL comment/);
  });
});
