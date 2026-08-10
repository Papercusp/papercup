import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import {
  assemble,
  budgetMatrix,
  CHARS_PER_TOKEN_KNOWN_MODEL,
  CHARS_PER_TOKEN_UNKNOWN_MODEL,
  cutOrder,
  MAX_SPILL_ENTRIES,
  MEMORY_WARN_FLOOR_CHARS,
  memoryWarningThreshold,
  partTargetsClient,
  PREAMBLE,
  projectClient,
  readOrder,
  SPILL_SECTION,
  verifyBodiesPresent,
} from '../../../../scripts/project-doc-parts.mjs';

/**
 * P-005 — projecting `harness_doc_parts` into the per-client files.
 *
 * ⚠ NOTHING HERE READS THE LIVE CLAUDE.md OR A DATABASE. Two earlier attempts in this
 * plan asserted against the live file and went red within minutes from an ordinary
 * peer edit, so every fixture below is synthetic and the composition/budget logic is
 * pure precisely so it can be tested without either.
 *
 * The load-bearing property is stated once and checked from several directions: the
 * composed output can NEVER exceed the budget. Everything else — which parts survive,
 * what the pointer says — is a quality of the degradation, not the guarantee.
 */

type Part = {
  part_key: string;
  kind: string;
  body: string;
  ordinal: number;
  client_scope: string[];
  target_section: string | null;
  project_rank: number;
};

let seq = 0;
function part(over: Partial<Part> = {}): Part {
  seq += 1;
  return {
    part_key: `p-${seq}`,
    kind: 'invariant',
    body: `body ${seq}`,
    ordinal: seq,
    client_scope: ['all'],
    target_section: 'Section A',
    project_rank: 100,
    ...over,
  };
}

const CLIENT = { client: 'claude', file: 'CLAUDE.md', reader: 'Claude Code', docId: 'synthetic' };

/** A part large enough to move the budget needle without writing 40k of fixture. */
function bulky(chars: number, over: Partial<Part> = {}): Part {
  return part({ body: 'x'.repeat(chars), ...over });
}

describe('memoryWarningThreshold — transcribed from the Claude Code bundle', () => {
  // These four are the measured values from the 2.1.226 bundle ($dn / si_ / ii_ / pk),
  // not a restatement of the formula: a test that only re-derives the formula from the
  // same constants cannot catch the constants themselves being wrong.
  it('200k context lands exactly on the floor', () => {
    expect(memoryWarningThreshold({ contextTokens: 200_000, charsPerToken: 4 })).toBe(40_000);
  });

  it('400k context doubles it', () => {
    expect(memoryWarningThreshold({ contextTokens: 400_000, charsPerToken: 4 })).toBe(80_000);
  });

  it('the floor wins for any small context — a tiny window never yields a tiny budget', () => {
    expect(memoryWarningThreshold({ contextTokens: 1_000, charsPerToken: 4 })).toBe(MEMORY_WARN_FLOOR_CHARS);
    expect(memoryWarningThreshold({ contextTokens: 200_000, charsPerToken: 3 })).toBe(MEMORY_WARN_FLOOR_CHARS);
  });

  it('an unrecognised model id (3 chars/token) yields a SMALLER budget than a known one', () => {
    const known = memoryWarningThreshold({ contextTokens: 400_000, charsPerToken: CHARS_PER_TOKEN_KNOWN_MODEL });
    const unknown = memoryWarningThreshold({ contextTokens: 400_000, charsPerToken: CHARS_PER_TOKEN_UNKNOWN_MODEL });
    expect(unknown).toBeLessThan(known);
    expect(unknown).toBe(60_000);
  });

  it('a non-finite context falls back to the bundle default rather than producing NaN', () => {
    expect(memoryWarningThreshold({ contextTokens: Number.NaN, charsPerToken: 4 })).toBe(40_000);
    expect(memoryWarningThreshold({ contextTokens: -1, charsPerToken: 4 })).toBe(40_000);
  });

  it('the reported matrix never claims a threshold below the floor', () => {
    for (const row of budgetMatrix()) expect(row.threshold).toBeGreaterThanOrEqual(MEMORY_WARN_FLOOR_CHARS);
  });
});

describe('composition', () => {
  it('emits each section heading once, before its first surviving part', () => {
    const parts = [
      part({ target_section: 'Alpha', body: 'a1' }),
      part({ target_section: 'Alpha', body: 'a2' }),
      part({ target_section: 'Beta', body: 'b1' }),
    ];
    const text = assemble(parts);
    expect(text).toBe('## Alpha\n\na1\n\na2\n\n## Beta\n\nb1\n');
    expect(text.match(/^## Alpha$/gm)).toHaveLength(1);
  });

  it('the (preamble) pseudo-section emits NO heading — it is a position, not a heading', () => {
    const text = assemble([part({ target_section: PREAMBLE, body: '# Title' }), part({ target_section: 'Alpha', body: 'a' })]);
    expect(text.startsWith('# Title\n')).toBe(true);
    expect(text).not.toContain(`## ${PREAMBLE}`);
  });

  it('a section reached again later re-emits its heading rather than merging silently', () => {
    // Not a wish — this is what ordinal order MEANS. If two runs of the same section
    // are separated by another, honouring the document order is the honest rendering.
    const text = assemble([
      part({ target_section: 'Alpha', body: 'a1' }),
      part({ target_section: 'Beta', body: 'b1' }),
      part({ target_section: 'Alpha', body: 'a2' }),
    ]);
    expect(text.match(/^## Alpha$/gm)).toHaveLength(2);
  });

  it('ends with exactly one trailing newline', () => {
    const text = assemble([part({ body: 'only' })]);
    expect(text.endsWith('only\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('CALIBRATION — verifyBodiesPresent passes on an honest composition', () => {
    const parts = [part({ body: 'first rule' }), part({ body: 'second rule' })];
    expect(verifyBodiesPresent(assemble(parts), parts)).toEqual([]);
  });

  it('CONTROL — verifyBodiesPresent NAMES a part the composition dropped or corrupted', () => {
    const parts = [part({ body: 'kept rule' }), part({ body: 'lost rule' })];
    const corrupted = assemble([parts[0]]);
    expect(verifyBodiesPresent(corrupted, parts)).toEqual([parts[1].part_key]);
  });
});

describe('client scoping — the two files are separate projections, not copies', () => {
  const parts = [
    part({ body: 'shared', client_scope: ['all'] }),
    part({ body: 'claude only', client_scope: ['claude'] }),
    part({ body: 'codex only', client_scope: ['codex'] }),
  ];

  it('all -> every client; a single-client part -> that client alone', () => {
    expect(parts.filter((p) => partTargetsClient(p, 'claude')).map((p) => p.body)).toEqual(['shared', 'claude only']);
    expect(parts.filter((p) => partTargetsClient(p, 'codex')).map((p) => p.body)).toEqual(['shared', 'codex only']);
  });

  it('a divergent part reaches its own file and NOT the other', () => {
    const claude = projectClient(parts, { ...CLIENT, client: 'claude', budget: 100_000 });
    const codex = projectClient(parts, { ...CLIENT, client: 'codex', file: 'AGENTS.md', budget: 100_000 });
    expect(claude.text).toContain('claude only');
    expect(claude.text).not.toContain('codex only');
    expect(codex.text).toContain('codex only');
    expect(codex.text).not.toContain('claude only');
  });

  it('an empty scope never projects — the corpus/projection boundary holds here too', () => {
    expect(partTargetsClient(part({ client_scope: [] }), 'claude')).toBe(false);
  });
});

describe('determinism — P-012 depends on this, and so does git-sync not churning the file every tick', () => {
  const parts = [
    part({ ordinal: 3, body: 'third', target_section: 'B' }),
    part({ ordinal: 1, body: 'first', target_section: 'A' }),
    part({ ordinal: 2, body: 'second', target_section: 'A' }),
  ];

  it('input row order does not affect the output', () => {
    const a = projectClient(parts, { ...CLIENT, budget: 100_000 }).text;
    const b = projectClient([...parts].reverse(), { ...CLIENT, budget: 100_000 }).text;
    expect(a).toBe(b);
    expect(a.indexOf('first')).toBeLessThan(a.indexOf('second'));
    expect(a.indexOf('second')).toBeLessThan(a.indexOf('third'));
  });

  it('repeated projection of unchanged rows is byte-identical', () => {
    const runs = new Set([1, 2, 3].map(() => projectClient(parts, { ...CLIENT, budget: 100_000 }).text));
    expect(runs.size).toBe(1);
  });

  it('parts sharing an ordinal are ordered by part_key, never by input order', () => {
    const tied = [
      part({ ordinal: 7, part_key: 'zzz', body: 'Z' }),
      part({ ordinal: 7, part_key: 'aaa', body: 'A' }),
    ];
    expect([...tied].sort(readOrder).map((p) => p.part_key)).toEqual(['aaa', 'zzz']);
    expect([...tied].reverse().sort(readOrder).map((p) => p.part_key)).toEqual(['aaa', 'zzz']);
  });
});

describe('the budget — the output can never exceed it', () => {
  /**
   * The guarantee, checked across budgets that force anywhere from no cut to a savage
   * one. A single over-budget case here is a real defect: the whole point of enforcing
   * in the projector is that an oversized file becomes impossible rather than unlikely.
   */
  it('holds for every budget from generous to brutal', () => {
    const parts = Array.from({ length: 30 }, (_, i) =>
      bulky(400, { ordinal: i + 1, target_section: `S${i % 5}`, project_rank: [100, 200, 300][i % 3] }),
    );
    for (const budget of [40_000, 20_000, 10_000, 6_000, 5_000]) {
      const out = projectClient(parts, { ...CLIENT, budget });
      expect(out.text.length).toBeLessThanOrEqual(budget);
    }
  });

  it('CALIBRATION — when everything fits, nothing is cut and no spill pointer appears', () => {
    const parts = [bulky(100), bulky(100)];
    const out = projectClient(parts, { ...CLIENT, budget: 100_000 });
    expect(out.dropped).toEqual([]);
    expect(out.text).not.toContain(SPILL_SECTION);
    expect(verifyBodiesPresent(out.text, out.kept)).toEqual([]);
  });

  it('CONTROL — an over-budget corpus is CUT, not emitted whole', () => {
    const parts = Array.from({ length: 20 }, (_, i) => bulky(1_000, { ordinal: i + 1 }));
    const out = projectClient(parts, { ...CLIENT, budget: 8_000 });
    expect(out.dropped.length).toBeGreaterThan(0);
    expect(out.kept.length).toBeLessThan(parts.length);
    expect(out.text.length).toBeLessThanOrEqual(8_000);
  });

  it('a cut is never silent — the spill pointer appears and names the cut parts it can', () => {
    const parts = Array.from({ length: 20 }, (_, i) => bulky(1_000, { ordinal: i + 1 }));
    const out = projectClient(parts, { ...CLIENT, budget: 8_000 });
    expect(out.text).toContain(SPILL_SECTION);
    const named = out.dropped.filter((d: { part_key: string }) => out.text.includes(d.part_key));
    expect(named.length).toBe(Math.min(out.dropped.length, MAX_SPILL_ENTRIES));
    // Whether or not the list was capped, the COUNT is always stated — the reader must
    // never have to infer from a truncated list how much is missing.
    expect(out.text).toContain(String(out.dropped.length));
  });

  it('every SURVIVING part is still present verbatim after a cut', () => {
    const parts = Array.from({ length: 20 }, (_, i) => bulky(1_000, { ordinal: i + 1 }));
    const out = projectClient(parts, { ...CLIENT, budget: 8_000 });
    expect(verifyBodiesPresent(out.text, out.kept)).toEqual([]);
  });

  it('the spill pointer is accounted for IN the budget, not added after it', () => {
    // The regression this guards: subtracting body lengths to decide the cut, then
    // appending a pointer that pushes the file back over. Many cut parts => a long
    // pointer, so this is where a subtractive estimate would break.
    const parts = Array.from({ length: 60 }, (_, i) => bulky(500, { ordinal: i + 1 }));
    const out = projectClient(parts, { ...CLIENT, budget: 6_000 });
    expect(out.dropped.length).toBeGreaterThan(30);
    expect(out.text.length).toBeLessThanOrEqual(6_000);
  });

  it('the spill pointer is BOUNDED — cutting 10x more parts does not grow it 10x', () => {
    // Found by this suite, and it was a real defect rather than a strict assertion: an
    // unbounded pointer grows exactly as the budget tightens, so past some point the
    // banner plus the pointer alone exceed the budget and the projector could only
    // refuse — a file that fails to generate, which is worse degradation than naming
    // fewer cut parts. The cap makes the block O(1), so it can never crowd out the
    // rules it is describing.
    const few = projectClient(
      Array.from({ length: 20 }, (_, i) => bulky(500, { ordinal: i + 1 })),
      { ...CLIENT, budget: 6_000 },
    );
    const many = projectClient(
      Array.from({ length: 200 }, (_, i) => bulky(500, { ordinal: i + 1 })),
      { ...CLIENT, budget: 6_000 },
    );
    expect(many.dropped.length).toBeGreaterThan(few.dropped.length * 5);

    const spillOf = (t: string) => t.slice(t.indexOf(SPILL_SECTION));
    // Bounded, not merely "smaller": a handful of chars for the "+N more" count is the
    // only way the larger cut may show up in the pointer's own size.
    expect(spillOf(many.text).length).toBeLessThan(spillOf(few.text).length + 200);
    expect(many.text.length).toBeLessThanOrEqual(6_000);
  });

  it('a capped pointer still says how many were cut, and how to recover ALL of them', () => {
    const out = projectClient(
      Array.from({ length: 200 }, (_, i) => bulky(500, { ordinal: i + 1 })),
      { ...CLIENT, budget: 6_000 },
    );
    expect(out.text).toMatch(/…and \d+ more/);
    expect(out.text).toContain(String(out.dropped.length));
    expect(out.text).toContain('harness_doc_parts');
  });

  it('safety rails survive longest: rank orders the cut, so invariants outlive pointers', () => {
    // gen-claude-md-manifest.mjs:134-138 — "rank orders the CUT if the budget bites,
    // and safety rails must survive". INV=100, REC=200, PTR=300: LOWER rank survives.
    const parts = [
      bulky(1_000, { ordinal: 1, project_rank: 100, kind: 'invariant', part_key: 'inv' }),
      bulky(1_000, { ordinal: 2, project_rank: 200, kind: 'recipe', part_key: 'rec' }),
      bulky(1_000, { ordinal: 3, project_rank: 300, kind: 'pointer', part_key: 'ptr' }),
    ];
    const out = projectClient(parts, { ...CLIENT, budget: 3_000 });
    expect(out.dropped.map((d) => d.part_key)).toContain('ptr');
    expect(out.kept.map((k) => k.part_key)).toContain('inv');
  });

  it('within one rank the LARGEST part is cut first — most rules retained per char surrendered', () => {
    const big = bulky(5_000, { ordinal: 1, project_rank: 100, part_key: 'big' });
    const small = bulky(100, { ordinal: 2, project_rank: 100, part_key: 'small' });
    expect([small, big].sort(cutOrder)[0].part_key).toBe('big');
  });

  it('cut order is total and stable — no pair is ever mutually "equal but different"', () => {
    const parts = [
      bulky(500, { ordinal: 1, project_rank: 100, part_key: 'a' }),
      bulky(500, { ordinal: 2, project_rank: 100, part_key: 'b' }),
    ];
    expect([...parts].sort(cutOrder).map((p) => p.part_key)).toEqual(['b', 'a']);
    expect([...parts].reverse().sort(cutOrder).map((p) => p.part_key)).toEqual(['b', 'a']);
  });

  it('a section whose every part was cut loses its heading too', () => {
    const parts = [
      part({ ordinal: 1, target_section: 'Survives', body: 'keep me', project_rank: 100 }),
      bulky(9_000, { ordinal: 2, target_section: 'Doomed', project_rank: 300 }),
    ];
    const out = projectClient(parts, { ...CLIENT, budget: 4_000 });
    expect(out.text).toContain('## Survives');
    expect(out.text).not.toContain('## Doomed');
  });

  it('CONTROL — a budget too small for even the pointer REFUSES rather than emitting over budget', () => {
    const parts = Array.from({ length: 5 }, (_, i) => bulky(1_000, { ordinal: i + 1 }));
    expect(() => projectClient(parts, { ...CLIENT, budget: 50 })).toThrow(/cannot fit/i);
  });
});
