/**
 * model-drift.test.ts — the D-015 guard for the four remaining pair families
 * (WI-6157). Sibling of `service-model-drift.test.ts`, which does the same job
 * for the service family.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Every pair file HAND-MODELS the tool it audits: `file-read.ts` copies
 * `capability:read`'s default page size, `postgres.ts` encodes which statements
 * `dev:pg_query` accepts, `process.ts` copies `dev:processes`' six kinds,
 * `git-read.ts` lists the git subcommands `capability:git` will run.
 *
 * That duplication is DELIBERATE and stays — an audit that imports its subject
 * proves nothing about it, because both sides would move together and the
 * verdict would track a shared constant instead of a real comparison.
 *
 * But WI-6153 showed the duplication had no guard, and that the `expectedVerdict`
 * latch structurally cannot be one: the latch recomputes a verdict from
 * `cover()`, and `cover()` reads the MODEL, never the real tool. So it catches
 * "model changed, verdict didn't" and is blind to "TOOL changed, model didn't" —
 * which is the common direction, because widening a tool is normal work done by
 * someone who never opens the audit. It happened exactly that way: `dev:service_health`
 * gained a :3170 probe, `pairs/service.ts` kept saying :3170 was unprobed, and both
 * user-facing `advisoryText` strings kept telling agents to shell out to curl for a
 * thing that now had a tool form. The whole suite stayed green.
 *
 * ── Both directions are load-bearing, and they fail differently ──────────────
 * The failure mode is NOT symmetric, and the diagnostics below say which one
 * fired:
 *
 *   TOOL WIDENS, model stale  → the pair UNDER-claims coverage. The recorded
 *     verdict stays `needs-widening`/`not-a-substitute` when the tool now works,
 *     and `advisoryText` actively advises AGAINST a tool that would serve the
 *     intent. This is the WI-6146 shape. `process.ts` is the sharpest case in
 *     the registry: its advisory literally says "no tool form; keep using bash".
 *
 *   TOOL NARROWS, model stale → the pair OVER-claims coverage. The verdict says
 *     `equivalent` on the strength of a capability that no longer exists, and
 *     once P-020 promotes that row past `tier:'observe'` the registry starts
 *     ENFORCING a substitution that returns an error.
 *
 * ── What is asserted ─────────────────────────────────────────────────────────
 * 1. The model constants equal their real counterparts (exact, both directions).
 * 2. The tool's PARAMETER SURFACE is pinned. Any added or removed arg reds here,
 *    because an arg is how a tool's capability envelope actually changes — and
 *    the envelope is what every verdict in this registry rests on.
 * 3. `cover()`'s emitted expressions only name parameters the tool really has,
 *    so the audit cannot promise an expression an agent is unable to evaluate.
 * 4. `advisoryText` prose that quotes a tool constant still quotes it correctly.
 *
 * A pin is a "come look at this once" ratchet, not a prohibition. When a new arg
 * genuinely does not change coverage, add it to the expected set WITH a one-line
 * reason — the same convention as `NON_ENDPOINT_PROBES` in the service guard.
 * Every silent exemption is a hole in the guard.
 */
import { describe, it, expect } from 'vitest';

// The real subjects. Imported HERE (in the guard) and never in the models.
import devProcesses, { KIND_ENUM } from '../../agent-tools/dev/processes';
import devPgQuery from '../../agent-tools/dev/pg_query';
import capabilityRead, { DEFAULT_LIMIT } from '../../agent-tools/capability/read';
import capabilityGit, { REFUSED_SUBCOMMANDS } from '../../agent-tools/capability/git';
import { assertSingleReadStatement } from '../../pg-read-query';

// The models under audit.
import { psProcessQuery, DEV_PROCESSES_KINDS } from './process';
import { psqlSelectRead, psqlDescribe } from './postgres';
import { sedRangeRead, catFileRead, headFileRead, tailFileRead, READ_DEFAULT_LIMIT } from './file-read';
import { gitReadPassthrough, READ_SUBCOMMANDS } from './git-read';

/** The tool's declared argument names, sorted. */
function argKeys(tool: unknown): string[] {
  const shape = (tool as { args?: { shape?: Record<string, unknown> } }).args?.shape;
  return Object.keys(shape ?? {}).sort();
}

/**
 * Assert a tool's parameter surface is exactly `expected`, with a diagnostic
 * that tells the reader WHY the audit cares and what to do about it.
 */
function expectArgSurface(tool: unknown, toolName: string, expected: string[], why: string): void {
  const actual = argKeys(tool);
  const added = actual.filter((k) => !expected.includes(k));
  const removed = expected.filter((k) => !actual.includes(k));
  expect(
    { added, removed },
    `${toolName}'s argument surface changed, so the bash-substitution model of it may be stale.\n` +
      `  added:   ${added.join(', ') || '(none)'}\n` +
      `  removed: ${removed.join(', ') || '(none)'}\n` +
      `Why this matters here: ${why}\n` +
      `An ADDED arg usually means the pair now UNDER-claims coverage — re-derive the verdict and check advisoryText ` +
      `is not still telling agents to shell out for something the tool now does (the WI-6146 regression). ` +
      `A REMOVED arg means the pair OVER-claims — cover() is emitting expressions the tool can no longer evaluate. ` +
      `If the change genuinely does not affect coverage, add the arg to the expected list with a one-line reason.`,
  ).toEqual({ added: [], removed: [] });
}

/**
 * Every parameter a pair's emitted `expression` names must exist on the tool it
 * routes to — otherwise the audit hands agents an expression they cannot run.
 * (The service guard's `UNIT_TO_PROBE` check is the same idea in that family's
 * shape.)
 */
function expectExpressionUsesRealArgs(
  pair: { id: string; cover: (atom: string) => { covered: boolean; expression?: string; reason?: string } },
  atom: string,
  tool: unknown,
  expectedParams: string[],
): void {
  const result = pair.cover(atom);
  expect(
    result.covered,
    `${pair.id} no longer covers its own canonical atom "${atom}" (reason: ${result.reason ?? 'none given'}). ` +
      `Either the model regressed or this atom stopped being representative — do not simply change the atom.`,
  ).toBe(true);

  const real = argKeys(tool);
  const bogus = expectedParams.filter((p) => !real.includes(p));
  expect(
    bogus,
    `${pair.id} builds an expression around parameters ${bogus.join(', ')} that ${
      (tool as { name?: string }).name ?? 'the tool'
    } does not accept — the audit is promising a call an agent cannot make.`,
  ).toEqual([]);

  const missing = expectedParams.filter((p) => !(result.expression ?? '').includes(`${p}:`));
  expect(
    missing,
    `${pair.id}'s expression for "${atom}" no longer names ${missing.join(', ')}. ` +
      `Expression was: ${result.expression ?? '(none)'}`,
  ).toEqual([]);
}

// ── dev:processes ↔ pairs/process.ts ────────────────────────────────────────

describe('process.ts model tracks the real dev:processes (D-015)', () => {
  it('DEV_PROCESSES_KINDS is exactly the tool\'s KIND_ENUM', () => {
    expect(
      [...DEV_PROCESSES_KINDS],
      `pairs/process.ts's copy of the six agent kinds has drifted from dev:processes' real KIND_ENUM. ` +
        `cover() uses this list to decide whether a pgrep maps onto { kinds: [...] }, so a stale copy either ` +
        `invents a kind the tool will reject, or misses one the tool now serves.`,
    ).toEqual([...KIND_ENUM]);
  });

  it('cover() actually routes each real kind through that list', () => {
    // Pins the CONSUMER, not just the constant: a refactor that stops consulting
    // DEV_PROCESSES_KINDS would leave the equality check above passing vacuously.
    for (const kind of KIND_ENUM) {
      const result = psProcessQuery.cover(`pgrep -f ${kind}`);
      expect(result.covered, `pgrep for the real agent kind '${kind}' is no longer covered`).toBe(true);
      expect(result.expression).toContain(`kinds: ['${kind}']`);
    }
  });

  it('dev:processes still has NO pid or name selector — the whole basis of the not-a-substitute verdict', () => {
    expectArgSurface(
      devProcesses,
      'dev:processes',
      ['kinds'],
      'the `not-a-substitute` verdict (0/24) rests on this tool having ONLY a kinds filter. A pid selector or a ' +
        'name/pattern filter would make 46.3% of the ps/pgrep family ("is MY job running") suddenly expressible, ' +
        'and this pair\'s advisoryText — which tells agents "no tool form; keep using bash" — would be actively wrong.',
    );
  });

  it('the verdict and advisory still say what the argument surface implies', () => {
    // A named, non-generic pin on the specific claim the advisory makes, so it
    // cannot be quietly loosened while the generic surface check is exempted.
    expect(psProcessQuery.expectedVerdict).toBe('not-a-substitute');
    expect(psProcessQuery.advisoryText).toContain('no pid or name selector');
    expect(argKeys(devProcesses)).not.toContain('pid');
    expect(argKeys(devProcesses)).not.toContain('pattern');
    expect(argKeys(devProcesses)).not.toContain('name');
  });
});

// ── dev:pg_query ↔ pairs/postgres.ts ────────────────────────────────────────

/**
 * Statements where the MODEL is knowingly stricter than the tool, with the
 * reason. Only ever model-rejects/tool-accepts: the opposite direction (the
 * model claiming something the tool refuses) is never exempt, because that is
 * the direction that ships a broken substitution.
 */
const MODEL_MORE_CONSERVATIVE: Record<string, string> = {
  // The model's MUTATING regex does not strip string literals, so a keyword
  // inside a quoted value reads as a mutation. The tool strips literals before
  // checking. Under-claiming is the safe direction, and stripping SQL literals
  // in the model would mean writing a second SQL lexer to audit the first.
  "select * from t where note = 'update the row'":
    'model does not strip string literals before the MUTATING check; tool does',
};

describe('postgres.ts model tracks the real dev:pg_query (D-015)', () => {
  it('dev:pg_query still has NO database/connection selector', () => {
    expectArgSurface(
      devPgQuery,
      'dev:pg_query',
      ['describe', 'maxRows', 'sql', 'timeoutMs'],
      'psqlSelectRead is deliberately NARROWED to a literal operator-Postgres connection because this tool has no ' +
        'database selector — 289 corpus atoms target $ODDS_DB/$PGURL/scratch databases and are excluded so agents ' +
        'are never nudged into silently querying the WRONG DATABASE. A connection/database arg would make those ' +
        'atoms claimable and the pattern must then be widened to match.',
    );
  });

  it('the `describe` mode psqlDescribe depends on still exists', () => {
    // psqlDescribe's `equivalent` verdict is ENTIRELY this arg: `\d` is a psql
    // client meta-command with no SQL form, so without `describe` those 88 atoms
    // have no tool expression at all and the verdict is wrong.
    expect(argKeys(devPgQuery)).toContain('describe');
    expect(psqlDescribe.expectedVerdict).toBe('equivalent');
  });

  it('the model and the tool agree on which statements are accepted', () => {
    const probes = [
      'select 1',
      'select * from harness_shared.work_items limit 5',
      'with x as (select 1) select * from x',
      "select * from t where note = 'update the row'",
      'show all',
      'explain select 1',
      'insert into t values (1)',
      'update t set a = 1',
      'delete from t',
      'vacuum analyze',
      'select 1; drop table t',
    ];

    const overclaims: string[] = [];
    const unexplainedGaps: string[] = [];

    for (const sql of probes) {
      const modelCovers = psqlSelectRead.cover(`psql -d papercusp -c "${sql}"`).covered;
      let toolAccepts = true;
      try {
        assertSingleReadStatement(sql);
      } catch {
        toolAccepts = false;
      }

      if (modelCovers && !toolAccepts) {
        // NEVER exempt: the audit would be advising a call the tool rejects.
        overclaims.push(`"${sql}" — model covers it, dev:pg_query REFUSES it`);
      } else if (!modelCovers && toolAccepts && !(sql in MODEL_MORE_CONSERVATIVE)) {
        unexplainedGaps.push(`"${sql}" — dev:pg_query accepts it, the model does not claim it`);
      }
    }

    expect(
      overclaims,
      `pairs/postgres.ts claims statements dev:pg_query will reject. This is the OVER-claim direction: the pair ` +
        `scores as \`equivalent\` on coverage the tool does not have, and enforcement would route agents into an ` +
        `error:\n  - ${overclaims.join('\n  - ')}`,
    ).toEqual([]);

    expect(
      unexplainedGaps,
      `dev:pg_query accepts statements the model does not claim — the tool was WIDENED and the model did not ` +
        `follow, so the pair under-reports coverage and its routing advice may be stale:\n  - ${unexplainedGaps.join(
          '\n  - ',
        )}\nIf a gap is deliberate, add it to MODEL_MORE_CONSERVATIVE with the reason.`,
    ).toEqual([]);
  });

  it('cover() emits expressions built only from real dev:pg_query args', () => {
    expectExpressionUsesRealArgs(psqlSelectRead, 'psql -d papercusp -c "select 1"', devPgQuery, ['sql']);
    expectExpressionUsesRealArgs(
      psqlDescribe,
      'psql -d papercusp -c "\\d harness_shared.work_items"',
      devPgQuery,
      ['describe'],
    );
  });
});

// ── capability:read ↔ pairs/file-read.ts ────────────────────────────────────

describe('file-read.ts model tracks the real capability:read (D-015)', () => {
  it('READ_DEFAULT_LIMIT is the tool\'s real DEFAULT_LIMIT', () => {
    expect(
      READ_DEFAULT_LIMIT,
      `pairs/file-read.ts mirrors capability:read's default page size to build \`head\`/\`cat\` expressions. If the ` +
        `tool's default changed and this copy did not, the audit emits an expression that reads a DIFFERENT number ` +
        `of lines than the bash command it claims to replace — a substitution that silently returns less than asked.`,
    ).toBe(DEFAULT_LIMIT);
  });

  it('capability:read still offers the exact windowing surface the family maps onto', () => {
    expectArgSurface(
      capabilityRead,
      'capability:read',
      ['file_path', 'limit', 'offset', 'tail'],
      'the four pairs in this family map directly onto these args: sed→offset+limit, head→limit, tail→tail, ' +
        'cat→file_path. `tail` in particular was ADDED to close the family\'s real gap (1,752 `tail -n N FILE` ' +
        'atoms across 63 sessions had no tool form); losing it would silently restore that gap while the pair ' +
        'still records `equivalent`. A multi-file or byte-window arg would invalidate the "single file_path" and ' +
        '"windows by LINE only" refusal reasons cover() returns.',
    );
  });

  it('cover() emits expressions built only from real capability:read args', () => {
    expectExpressionUsesRealArgs(sedRangeRead, "sed -n '10,20p' /tmp/a.log", capabilityRead, [
      'file_path',
      'offset',
      'limit',
    ]);
    expectExpressionUsesRealArgs(headFileRead, 'head -n 40 /tmp/a.log', capabilityRead, ['file_path', 'limit']);
    expectExpressionUsesRealArgs(tailFileRead, 'tail -n 40 /tmp/a.log', capabilityRead, ['file_path', 'tail']);
    expectExpressionUsesRealArgs(catFileRead, 'cat /tmp/a.log', capabilityRead, ['file_path']);
  });

  it('advisoryText prose still quotes the real page size', () => {
    // catFileRead's advisory states the paging number in PROSE. That string is
    // what an agent reads, so it drifts exactly like the model constants do —
    // and unlike them, nothing else would ever recompute it.
    const quoted = /paged at (\d+) lines/.exec(catFileRead.advisoryText);
    expect(quoted, `catFileRead.advisoryText no longer states its paging size: ${catFileRead.advisoryText}`).not.toBeNull();
    expect(
      Number(quoted?.[1]),
      `catFileRead's advisoryText tells agents the read is "paged at ${quoted?.[1]} lines", but capability:read ` +
        `actually pages at ${DEFAULT_LIMIT}. The advisory is user-facing guidance and is now wrong.`,
    ).toBe(DEFAULT_LIMIT);
  });
});

// ── capability:git ↔ pairs/git-read.ts ──────────────────────────────────────

describe('git-read.ts model tracks the real capability:git (D-015)', () => {
  it('no subcommand the model claims is refused by the tool', () => {
    const refused = READ_SUBCOMMANDS.filter((sub) => REFUSED_SUBCOMMANDS.has(sub));
    expect(
      refused,
      `pairs/git-read.ts claims these subcommands are substitutable, but capability:git REFUSES them — the ` +
        `registry would advise a call that returns { ok: false, reason: 'refused' }:\n  - ${refused.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('nothing the tool refuses has crept into the read list', () => {
    // The other direction: a newly-refused subcommand must be removed from the
    // model, not merely absent from the corpus.
    const leaked = [...REFUSED_SUBCOMMANDS].filter((sub) => (READ_SUBCOMMANDS as readonly string[]).includes(sub));
    expect(
      leaked,
      `capability:git refuses these, yet they are listed as read-substitutable:\n  - ${leaked.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('capability:git still takes argv + cwd — the surface the passthrough maps onto', () => {
    expectArgSurface(
      capabilityGit,
      'capability:git',
      ['args', 'cwd'],
      'gitReadPassthrough rewrites the whole command as literal argv, and maps `git -C <dir>` / `--git-dir` / ' +
        '`--work-tree` onto `cwd` (140 corpus atoms point at a sibling worktree). Losing `cwd` would make every ' +
        'one of those expressions run in the WRONG REPOSITORY while still reporting success.',
    );
  });

  it('cover() emits expressions built only from real capability:git args', () => {
    expectExpressionUsesRealArgs(
      gitReadPassthrough,
      'git -C /tmp/repo log --oneline -5',
      capabilityGit,
      ['args', 'cwd'],
    );
  });
});
