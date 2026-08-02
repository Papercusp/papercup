/**
 * Tests for the P-005 ceiling classifier and the P-006 pipe-filter evidence.
 *
 * What these are actually guarding: every classification mistake in this module
 * moves a published percentage, and every mistake in the OPTIMISTIC direction
 * (calling something substitutable that is not) invents headroom the programme
 * can never occupy. So the assertions below concentrate on the pessimistic rules
 * — writes, elevation, follow-streams, and the "a matching row whose verdict is
 * `not-a-substitute` is not coverage" correction to D-050.
 */

import { describe, expect, it } from 'vitest';
import { atomize, atomizePipeline } from './atomize';
import { classifyAtom, loadCensusAtoms, runCensus, type CensusAtom } from './census';
import type { SubstitutionPair } from './types';

/** Build a census atom the way `loadCensusAtoms` would, for one command. */
function atomsOf(command: string, sid = 's1'): CensusAtom[] {
  return atomizePipeline(command).map((part) => ({
    sid,
    ts: '2026-08-02T00:00:00Z',
    atom: part.atom,
    raw: part.raw,
    head: part.atom.split(/\s+/)[0].split('/').pop() ?? '',
    pipedInto: part.pipedInto,
    upstream: part.upstream,
    upstreamHead: part.upstream?.split(/\s+/)[0].split('/').pop() ?? null,
    pipelineRoot: part.pipelineRoot,
    pipelineRootHead: part.pipelineRoot?.split(/\s+/)[0].split('/').pop() ?? null,
  }));
}

const IRREDUCIBLE_ONLY = { pipeFilterPolicy: 'irreducible' } as const;

function pair(overrides: Partial<SubstitutionPair> & Pick<SubstitutionPair, 'id' | 'bashPattern' | 'expectedVerdict'>): SubstitutionPair {
  return {
    intentLabel: 'test-intent',
    toolName: 'test:tool',
    advisoryText: 'use the tool',
    routing: { want: 'w', use: 'u', insteadOf: 'i' },
    cover: () => ({ covered: true }),
    ...overrides,
  } as SubstitutionPair;
}

describe('atomizePipeline', () => {
  it('records which atoms read from a pipe and what feeds them', () => {
    const parts = atomizePipeline('cat a.ts | head -5');
    expect(parts.map((p) => p.atom)).toEqual(['cat a.ts', 'head -5']);
    expect(parts[0]).toMatchObject({ pipedInto: false, upstream: null });
    expect(parts[1]).toMatchObject({ pipedInto: true, upstream: 'cat a.ts' });
  });

  it('does not treat `&&`, `;` or a newline as a pipe', () => {
    for (const sep of ['&&', ';', '\n']) {
      const parts = atomizePipeline(`cat a.ts ${sep} head -5`);
      expect(parts[1]?.pipedInto, sep).toBe(false);
      expect(parts[1]?.upstream, sep).toBeNull();
    }
  });

  it('keeps the pre-normalisation text so elevation stays visible', () => {
    const [part] = atomizePipeline('sudo journalctl -u papercup');
    expect(part.atom).toBe('journalctl -u papercup');
    expect(part.raw).toBe('sudo journalctl -u papercup');
  });

  it('agrees with atomize on the atom list itself', () => {
    for (const command of [
      "cd /repo && sed -n '1,40p' a.ts | head -5",
      'for f in a b; do node t.mjs | head -3; done',
      "psql -c 'SELECT 1' | wc -l",
    ]) {
      expect(atomizePipeline(command).map((p) => p.atom)).toEqual(atomize(command));
    }
  });
});

describe('classifyAtom — the pessimistic rules fire before any claim of coverage', () => {
  it('rules shell plumbing irreducible', () => {
    for (const command of ['cd /repo', 'echo hello', 'export FOO=1', '[ -f x ]']) {
      expect(classifyAtom(atomsOf(command)[0], IRREDUCIBLE_ONLY).disposition, command).toBe('irreducible');
    }
  });

  it('rules job-liveness polling should-not-happen, not covered', () => {
    for (const command of ['sleep 5', 'pgrep -f vitest', 'ps aux']) {
      const verdict = classifyAtom(atomsOf(command)[0], IRREDUCIBLE_ONLY);
      expect(verdict.disposition, command).toBe('should-not-happen');
      expect(verdict.reason).toMatch(/P-014/);
    }
  });

  it('rules an output redirection irreducible even when a registry row matches the verb', () => {
    const pairs = [pair({ id: 'x.git', bashPattern: /^git\b/, expectedVerdict: 'equivalent' })];
    const [entry] = atomsOf('git log --oneline > /tmp/out.log');
    expect(classifyAtom(entry, { ...IRREDUCIBLE_ONLY, pairs }).disposition).toBe('irreducible');
  });

  it('does not mistake `2>&1` stream plumbing for a file write', () => {
    const pairs = [pair({ id: 'x.tsc', bashPattern: /^npx tsc\b/, expectedVerdict: 'equivalent' })];
    const [entry] = atomsOf('npx tsc --noEmit 2>&1');
    expect(classifyAtom(entry, { ...IRREDUCIBLE_ONLY, pairs }).disposition).toBe('covered');
  });

  it('does not mistake noise suppression for a file write', () => {
    // Regression: counting `2>/dev/null` as a write moved `find` (2,973 atoms)
    // and `cat` (2,507) into `irreducible` on the strength of a trailing
    // redirect that produces no file — a 3.9pt error in the pessimistic direction.
    for (const command of ['find . -name "*.ts" 2>/dev/null', 'ls -la /tmp &>/dev/null', 'cat a.ts 2>/dev/null']) {
      expect(classifyAtom(atomsOf(command)[0], IRREDUCIBLE_ONLY).rule, command).not.toBe('output-redirect');
    }
  });

  it('still counts a real file write', () => {
    for (const command of ['cat a.ts > b.ts', 'git log >> /tmp/out.log', 'echo hi > /tmp/x']) {
      expect(classifyAtom(atomsOf(command)[0], IRREDUCIBLE_ONLY).disposition, command).toBe('irreducible');
    }
    expect(classifyAtom(atomsOf('cat a.ts > b.ts')[0], IRREDUCIBLE_ONLY).rule).toBe('output-redirect');
  });

  it('rules an elevated command irreducible', () => {
    expect(classifyAtom(atomsOf('sudo systemctl restart x')[0], IRREDUCIBLE_ONLY).rule).toBe('elevated');
  });

  it('rules a follow-stream irreducible but not a bounded tail', () => {
    expect(classifyAtom(atomsOf('tail -f /tmp/a.log')[0], IRREDUCIBLE_ONLY).rule).toBe('follow-stream');
    expect(classifyAtom(atomsOf('tail -n 25 /tmp/a.log')[0], IRREDUCIBLE_ONLY).rule).not.toBe('follow-stream');
  });
});

describe('classifyAtom — a matching row is not automatically coverage (the D-050 correction)', () => {
  it('counts a match on an `equivalent` row as covered', () => {
    const pairs = [pair({ id: 'good.row', bashPattern: /^cat\b/, expectedVerdict: 'equivalent' })];
    const verdict = classifyAtom(atomsOf('cat a.ts')[0], { ...IRREDUCIBLE_ONLY, pairs });
    expect(verdict.disposition).toBe('covered');
    expect(verdict.reason).toContain('good.row');
  });

  it('refuses to count a match on a `not-a-substitute` row as covered', () => {
    const pairs = [pair({ id: 'bad.row', bashPattern: /^lsof\b/, expectedVerdict: 'not-a-substitute' })];
    const verdict = classifyAtom(atomsOf('lsof -i :3070')[0], { ...IRREDUCIBLE_ONLY, pairs });
    expect(verdict.disposition).toBe('needs-tool');
    expect(verdict.reason).toMatch(/not coverage/);
  });

  it('is not corrupted by a stateful /g pattern reused across atoms', () => {
    const pairs = [pair({ id: 'g.row', bashPattern: /^cat\b/g, expectedVerdict: 'equivalent' })];
    const entries = atomsOf('cat a.ts\ncat b.ts\ncat c.ts');
    for (const entry of entries) {
      expect(classifyAtom(entry, { ...IRREDUCIBLE_ONLY, pairs }).disposition).toBe('covered');
    }
  });
});

describe('classifyAtom — the P-006 pipe-filter class is a parameter, not an assumption', () => {
  const [, filter] = atomsOf('cat a.ts | head -5');

  it('is irreducible under policy (a)', () => {
    expect(classifyAtom(filter, { pipeFilterPolicy: 'irreducible' }).disposition).toBe('irreducible');
  });

  it('is reachable-with-a-new-tool under policy (b)', () => {
    const verdict = classifyAtom(filter, { pipeFilterPolicy: 'projection' });
    expect(verdict.disposition).toBe('needs-tool');
    expect(verdict.reason).toMatch(/P-020/);
  });

  it('leaves a filter WITH a file operand out of the class entirely', () => {
    const [entry] = atomsOf('head -5 a.ts');
    expect(classifyAtom(entry, { pipeFilterPolicy: 'irreducible' }).rule).not.toMatch(/^pipe-filter/);
  });

  describe('policy (c) producer-aware', () => {
    const PRODUCER_AWARE = { pipeFilterPolicy: 'producer-aware' } as const;

    it('is reachable when the producer is a tool call', () => {
      const parts = atomsOf('journalctl -u papercup | tail -20');
      expect(classifyAtom(parts[1], PRODUCER_AWARE).rule).toBe('pipe-filter:absorbable');
    });

    it('stays irreducible when the producer has no tool form', () => {
      const parts = atomsOf('./scripts/run.sh | tail -20');
      expect(classifyAtom(parts[1], PRODUCER_AWARE).rule).toBe('pipe-filter:no-producer');
    });

    it('follows a multi-stage chain back to its ROOT, not just one level up', () => {
      // `sort` is itself an operand-less filter, so a one-level producer test
      // would call this chain unreachable. It is one tool call plus a projection.
      const parts = atomsOf('grep -rn foo packages/ | sort | head -5');
      expect(parts[2]).toMatchObject({ upstream: 'sort', pipelineRoot: 'grep -rn foo packages/' });
      expect(classifyAtom(parts[2], PRODUCER_AWARE).rule).toBe('pipe-filter:absorbable');
    });

    it('sits between the two blanket policies, which is the whole point', () => {
      const corpus = [
        ...atomsOf('journalctl -u papercup | tail -20', 's1'),
        ...atomsOf('./scripts/run.sh | tail -20', 's1'),
      ];
      const strict = runCensus(corpus, { pipeFilterPolicy: 'irreducible' }).reachableCeilingPct;
      const middle = runCensus(corpus, { pipeFilterPolicy: 'producer-aware' }).reachableCeilingPct;
      const blanket = runCensus(corpus, { pipeFilterPolicy: 'projection' }).reachableCeilingPct;
      expect(middle).toBeGreaterThan(strict);
      expect(middle).toBeLessThan(blanket);
    });
  });
});

describe('runCensus', () => {
  const corpus = [
    ...atomsOf('cd /repo && echo hi', 's1'),
    ...atomsOf('sleep 5', 's1'),
    ...atomsOf('cat a.ts | head -5', 's2'),
    ...atomsOf('git log --oneline -5', 's3'),
  ];

  it('classifies every atom — the rows sum to 100% of bash volume', () => {
    const report = runCensus(corpus, IRREDUCIBLE_ONLY);
    const classified = Object.values(report.byDisposition).reduce((sum, d) => sum + d.atoms, 0);
    expect(classified).toBe(report.totalAtoms);
    expect(report.rows.reduce((sum, row) => sum + row.atoms, 0)).toBe(report.totalAtoms);
  });

  it('states the ceiling as 1 - irreducible - should-not-happen', () => {
    const report = runCensus(corpus, IRREDUCIBLE_ONLY);
    expect(report.reachableCeilingPct).toBeCloseTo(
      100 - report.byDisposition.irreducible.pct - report.byDisposition['should-not-happen'].pct,
      5,
    );
  });

  it('moves the ceiling when the P-006 policy changes — which is why it is a decision', () => {
    const strict = runCensus(corpus, { pipeFilterPolicy: 'irreducible' });
    const projected = runCensus(corpus, { pipeFilterPolicy: 'projection' });
    expect(projected.reachableCeilingPct).toBeGreaterThan(strict.reachableCeilingPct);
  });

  it('reports whether a pipe filter has a producer a projection could attach to', () => {
    const report = runCensus(corpus, { pipeFilterPolicy: 'projection' });
    expect(report.pipeFilter.atoms).toBe(1);
    expect(report.pipeFilter.upstreams[0]).toMatchObject({ head: 'cat' });
  });

  it('reports a SPLIT head as a mix rather than labelling it with one atom', () => {
    // `grep` is the largest head in the corpus and it is not one thing: piped it
    // is the P-006 population, unpiped it is a code search over a path. Reporting
    // whichever atom happened to be seen first is how a census hides a split.
    const split = [
      ...atomsOf('cat a.ts | grep foo', 's1'),
      ...atomsOf('grep -rn foo packages/', 's1'),
      ...atomsOf('grep -rn bar packages/', 's2'),
    ];
    const [row] = runCensus(split, IRREDUCIBLE_ONLY).rows.filter((r) => r.head === 'grep');
    expect(row.atoms).toBe(3);
    expect(row.mix.map((m) => m.rule).sort()).toEqual(['code-search-partial', 'pipe-filter:irreducible']);
    // Plurality wins the headline; the minority is still visible in the mix.
    expect(row.disposition).toBe('tool-exists');
    expect(row.mix.reduce((sum, m) => sum + m.atoms, 0)).toBe(row.atoms);
  });

  it('ranks by atoms x sessions, not atoms alone', () => {
    const wide = [
      ...Array.from({ length: 3 }, (_, i) => atomsOf('ls -la', `s${i}`)).flat(),
      ...Array.from({ length: 5 }, () => atomsOf('docker ps', 'solo')).flat(),
    ];
    const report = runCensus(wide, IRREDUCIBLE_ONLY);
    // docker has more atoms (5 > 3); ls has more sessions (3 > 1) and wins 9 > 5.
    expect(report.rows[0].head).toBe('ls');
  });
});

describe('loadCensusAtoms', () => {
  it('reports the raw call count alongside the atoms, so both denominators are stated', () => {
    // The extract lives outside the repo (see corpus.ts); this asserts the shape
    // contract on a temp file rather than depending on the corpus being present.
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'census-')), 'calls.jsonl');
    writeFileSync(file, [
      JSON.stringify({ sid: 's1', ts: 't', cmd: 'cat a.ts | head -5' }),
      'not json',
      JSON.stringify({ sid: 's2', ts: 't', cmd: 'cd /repo' }),
    ].join('\n'));

    const { atoms, calls } = loadCensusAtoms(file);
    expect(calls).toBe(2);
    expect(atoms.map((a) => a.head)).toEqual(['cat', 'head', 'cd']);
    expect(atoms[1]).toMatchObject({ pipedInto: true, upstreamHead: 'cat' });
  });
});
