/**
 * The committed equivalence harness test (plan
 * `bash-to-tool-substitution-2026-07-26`, P-004/P-005).
 *
 * This is the anti-rot latch the plan asks for. Each pair declares the verdict
 * it is RECORDED as carrying; the harness recomputes that verdict from frozen
 * samples of real commands. If someone changes a tool's capability (or the
 * envelope that models it) without re-recording the verdict, this test fails —
 * so a registry row can never quietly claim an equivalence the tool no longer
 * provides, which is the whole basis of D-001's enforcement gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { atomize, atomHead, normalizeAtom } from './atomize';
import { auditPair, deriveVerdict, matchingAtoms, maxTierFor, MIN_SAMPLE_SIZE } from './equivalence';
import { FILE_READ_PAIRS, catFileRead, headFileRead, sedRangeRead, tailFileRead } from './pairs/file-read';
import type { CorpusFixture } from './corpus';
import type { SampledCommand } from './types';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(pairId: string): CorpusFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${pairId}.sample.json`), 'utf8')) as CorpusFixture;
}

describe('atomize', () => {
  it('splits compound commands on every shell separator', () => {
    expect(atomize("cd /repo && sed -n '1,40p' a.ts | head -5")).toEqual([
      'cd /repo',
      "sed -n '1,40p' a.ts",
      'head -5',
    ]);
    expect(atomize('a; b || c')).toEqual(['a', 'b', 'c']);
  });

  it('strips runner wrappers and env assignments so the verb is at position 0', () => {
    expect(normalizeAtom('sudo -n journalctl -u x')).toBe('journalctl -u x');
    expect(normalizeAtom('PGPASSWORD=x timeout 30 psql -c "select 1"')).toBe('psql -c "select 1"');
    expect(normalizeAtom('nohup npm run build')).toBe('npm run build');
  });

  it('reduces a verb to its bare name', () => {
    expect(atomHead('/usr/bin/psql -c x')).toBe('psql');
    expect(atomHead('   ')).toBeNull();
  });
});

describe('verdict derivation (D-008 — total coverage or it is not equivalent)', () => {
  it('requires every sampled command to be covered', () => {
    expect(deriveVerdict(20, 20)).toBe('equivalent');
    // The near-miss is deliberately NOT equivalent: the pattern is the unit of
    // enforcement, so one uncovered command means one agent nudged toward a
    // tool that cannot do the job.
    expect(deriveVerdict(19, 20)).toBe('needs-widening');
    expect(deriveVerdict(0, 20)).toBe('not-a-substitute');
    expect(deriveVerdict(0, 0)).toBe('unaudited');
  });

  it('only an equivalent verdict may be promoted past observe', () => {
    expect(maxTierFor('equivalent')).toBe('advise');
    expect(maxTierFor('needs-widening')).toBe('observe');
    expect(maxTierFor('not-a-substitute')).toBe('observe');
    expect(maxTierFor('unaudited')).toBe('observe');
  });

  it('refuses to produce a verdict from an under-sized sample', () => {
    const thin: SampledCommand[] = [{ sid: 'su-x', ts: '2026-07-26T00:00:00Z', atom: 'cat /tmp/a.log' }];
    expect(() => auditPair(catFileRead, thin)).toThrow(/need >= 20/);
  });
});

describe.each(FILE_READ_PAIRS)('pair $id', (pair) => {
  const fixture = loadFixture(pair.id);

  it(`carries a sample of at least ${MIN_SAMPLE_SIZE} real commands`, () => {
    expect(fixture.sample.length).toBeGreaterThanOrEqual(MIN_SAMPLE_SIZE);
    // Every sampled command must be a real one drawn from the corpus, not a
    // hand-written example that happens to pass.
    for (const entry of fixture.sample) {
      expect(entry.sid).toMatch(/^su-|^[0-9a-f-]{8,}/);
    }
  });

  it('records the verdict the harness actually computes', () => {
    const audit = auditPair(pair, fixture.sample);
    expect(audit.verdict).toBe(pair.expectedVerdict);
    expect(audit.sampleSize).toBe(fixture.sample.length);
  });

  it('explains every failure it reports', () => {
    const audit = auditPair(pair, fixture.sample);
    for (const failure of audit.failingCases) {
      expect(failure.reason.length).toBeGreaterThan(10);
      expect(failure.atom).toBeTruthy();
    }
    // An `equivalent` verdict must have nothing left to explain.
    if (audit.verdict === 'equivalent') expect(audit.failingCases).toHaveLength(0);
  });

  it('produces a concrete tool expression for every covered command', () => {
    for (const entry of fixture.sample) {
      const result = pair.cover(entry.atom);
      if (result.covered) {
        expect(result.expression).toContain(pair.toolName);
      } else {
        expect(result.reason).toBeTruthy();
      }
    }
  });
});

/**
 * Regression guards for the mis-scorings the harness caught on its first real
 * run. Each of these was a live bug in the envelope, and each would have
 * produced a WRONG verdict — two of them optimistic.
 */
describe('file-read pattern boundaries', () => {
  const claims = (pair: (typeof FILE_READ_PAIRS)[number], atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  it('excludes pipe filters, which are stream shaping and not file reads', () => {
    // `head`/`tail` are dominated by this form (11,381 head atoms, only 408
    // distinct) — claiming them would swamp the registry with false advisories.
    expect(claims(headFileRead, 'head -20')).toBe(false);
    expect(claims(tailFileRead, 'tail -16')).toBe(false);
    expect(claims(sedRangeRead, 'sed -n "1,200p"')).toBe(false);
  });

  it('excludes heredocs and stdout redirects, which are writes', () => {
    expect(claims(catFileRead, "cat > /tmp/x.ts << 'EOF'")).toBe(false);
    expect(claims(catFileRead, 'cat /tmp/a.log > /tmp/b.log')).toBe(false);
  });

  it('treats a stderr redirect as noise, not as a write', () => {
    // `2>/dev/null` rides on a large share of real reads; scoring it as a write
    // mis-failed a third of the cat sample.
    expect(claims(catFileRead, 'cat /tmp/a.log 2>/dev/null')).toBe(true);
    expect(catFileRead.cover('cat /tmp/a.log 2>/dev/null').covered).toBe(true);
  });

  it('does not mistake a flag argument for a second file', () => {
    // `tail -n 40 FILE` parses as flag(-n) arg(40) operand(FILE) — reading `40`
    // as a filename made every -n form look like a two-file read.
    const result = tailFileRead.cover('tail -n 40 /tmp/run.log');
    expect(result.covered).toBe(true);
    expect(result.expression).toContain('tail: 40');
  });

  it('excludes shell expansion, which has no literal path to pass', () => {
    expect(claims(catFileRead, 'cat $TRIAGE/scn.log')).toBe(false);
    expect(claims(catFileRead, 'cat "$B/build-provenance.json"')).toBe(false);
  });

  it('claims ~/ paths now that capability:read expands them', () => {
    expect(claims(catFileRead, 'cat ~/.papercusp/live-fed-gate/last-downgrade')).toBe(true);
    expect(catFileRead.cover('cat ~/.papercusp/state').covered).toBe(true);
  });

  it('excludes follow mode and byte windows as different intents', () => {
    expect(claims(tailFileRead, 'tail -f /tmp/run.log')).toBe(false);
    expect(claims(tailFileRead, 'tail -c 2000 /tmp/run.log')).toBe(false);
  });

  it('maps a sed range onto offset+limit exactly', () => {
    const result = sedRangeRead.cover("sed -n '110,200p' packages/operator-core/lib/x.ts");
    expect(result.covered).toBe(true);
    expect(result.expression).toContain('offset: 110');
    expect(result.expression).toContain('limit: 91');
  });
});
