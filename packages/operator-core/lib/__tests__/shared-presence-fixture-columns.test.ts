/**
 * shared-presence-fixture-columns.test.ts — the EI-18817201237512691 recurrence guard.
 *
 * THE INCIDENT CLASS. `harness_shared.shared_presence` has ~9 hand-rolled
 * `CREATE TABLE` fixtures scattered across integration tests and rig helpers.
 * Every migration that adds a column to the real table silently rots ALL of them,
 * and the failure is maximally misleading: the presence projection's `applyPut` is
 * best-effort, so the PG error is SWALLOWED and the visible symptom is an unrelated
 * assertion ("expected undefined to be truthy") in whatever test happened to run.
 * The error, when it does surface, names a COLUMN — never the stale fixture — so it
 * reads as a bug in whatever you just changed.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. presence-gossip-wiring.integration.test.ts
 * already carried the comment "Keep this column list in step with
 * projections/presence.ts's INSERT" — written after this exact bug bit once. It did
 * not hold: migration 724 added `active_routines` and ALL NINE copies drifted anyway,
 * including the one carrying the comment. On 2026-08-02 a fix that patched only
 * migration 682's `runs_routines` was itself re-broken by 724's `active_routines`
 * inside the same hour. Prose exhortation is not enforcement; this is the gate.
 *
 * WHAT IT ASSERTS. The projection's INSERT column list is the SOURCE OF TRUTH (it is
 * what actually executes against these fixtures). Every hand-rolled fixture must
 * declare every column that INSERT names. Deliberate exceptions are allowlisted BY
 * PATH WITH A REASON — an unexplained exception is not possible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF_PATH), '../../../..');
const PROJECTION_REL = 'packages/operator-core/lib/sync/hyperbee/projections/presence.ts';
const SCAN_ROOTS = ['packages', 'libs', 'apps'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '_retired',
  'target',
]);

/**
 * Fixtures that deliberately model a SUPERSEDED schema shape. Each entry must say
 * WHY the divergence is correct — i.e. why the presence projection never writes to
 * this fixture's table. Adding a path here without that justification defeats the
 * guard; adding one because a test went red is the bug, not the fix.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'packages/operator-core/lib/harness/lifecycle-membership-teardown.integration.test.ts',
    'Deliberately models the PRE-RENAME `hive_slug` shape (mig 187, before the 506/523 pot-rename) ' +
      'and INSERTs its rows directly. The presence projection never runs against this fixture, so ' +
      'aligning it to the live column set would break the direct inserts it does make.',
  ],
]);

/** The columns the presence projection's upsert actually names — the source of truth. */
function projectionColumns(): string[] {
  const src = readFileSync(join(REPO_ROOT, PROJECTION_REL), 'utf8');
  const m = /INSERT\s+INTO\s+harness_shared\.shared_presence\s*\(([^)]*)\)/i.exec(src);
  if (!m) throw new Error(`could not locate the shared_presence INSERT in ${PROJECTION_REL}`);
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && /^[a-z_][a-z0-9_]*$/i.test(c));
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTsFiles(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Extract each `CREATE TABLE ... harness_shared.shared_presence ( ... )` body by
 * balancing parens from the table's opening paren — a plain `[^)]*` cannot work
 * here because column types like `timestamptz DEFAULT now()` contain parens.
 */
function sharedPresenceDdlBodies(text: string): string[] {
  const bodies: string[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?harness_shared\.shared_presence\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      i += 1;
    }
    if (depth === 0) bodies.push(text.slice(start, i - 1));
  }
  return bodies;
}

function declaresColumn(body: string, col: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${col}([^a-z0-9_]|$)`, 'i').test(body);
}

describe('hand-rolled shared_presence fixtures track the presence projection (EI-18817201237512691)', () => {
  const columns = projectionColumns();

  it('finds the projection INSERT column list', () => {
    // Locks the extraction itself — if the projection is refactored such that this
    // regex stops matching, we must fail HERE with a clear message rather than
    // silently degrade to asserting an empty column set against every fixture.
    expect(columns.length).toBeGreaterThan(10);
    expect(columns).toContain('runs_routines');
    expect(columns).toContain('active_routines');
    expect(columns).toContain('workspace_id');
  });

  it('every fixture declares every column the projection writes', () => {
    const files = SCAN_ROOTS.flatMap((r) => walkTsFiles(join(REPO_ROOT, r)));
    const offenders: string[] = [];
    let fixturesSeen = 0;

    for (const file of files) {
      // Skip THIS file: its own negative-control block below deliberately embeds
      // partial/synthetic `shared_presence` DDL strings to exercise the extractor,
      // and those are not real fixtures — scanning them here would self-flag as an
      // offender regardless of every real fixture's actual state.
      if (file === SELF_PATH) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('harness_shared.shared_presence')) continue;
      const bodies = sharedPresenceDdlBodies(text);
      if (bodies.length === 0) continue;

      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      fixturesSeen += 1;
      if (ALLOWLIST.has(rel)) continue;

      for (const body of bodies) {
        const missing = columns.filter((c) => !declaresColumn(body, c));
        if (missing.length > 0) {
          offenders.push(`${rel} — missing: ${missing.join(', ')}`);
        }
      }
    }

    // Guard the guard: if the scan stops finding fixtures (a move, a rename, a
    // broken walk), an empty offender list would read as a pass forever.
    expect(fixturesSeen).toBeGreaterThanOrEqual(5);

    expect(
      offenders,
      `Hand-rolled harness_shared.shared_presence fixture(s) have drifted from ` +
        `${PROJECTION_REL}'s INSERT. The projection's applyPut swallows the PG error, so this ` +
        `surfaces as an unrelated assertion failure in some other test — add the missing ` +
        `column(s) to the fixture DDL. If a fixture diverges ON PURPOSE, add it to ALLOWLIST ` +
        `in this file WITH the reason the projection never writes to it.\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every allowlisted exception carries a justification', () => {
    for (const [path, reason] of ALLOWLIST) {
      expect(reason.trim().length, `${path} needs a real justification`).toBeGreaterThan(40);
    }
  });
});

/**
 * The negative control. A guard whose red you have never watched fire is not yet an
 * instrument — but the real fixtures cannot be broken to prove it: this is a SHARED
 * tree and git-sync commits the whole thing on a timer, so a deliberate temporary
 * break would be committed as a real regression. So the detector is exercised on
 * SYNTHETIC DDL instead (the shape check-explicit-presence.test.ts uses).
 */
describe('the fixture detector actually detects (negative control)', () => {
  const complete = `
    CREATE TABLE harness_shared.shared_presence (
      workspace_id text DEFAULT '' NOT NULL,
      last_seen_at timestamptz DEFAULT now() NOT NULL,
      runs_routines boolean,
      active_routines text[],
      PRIMARY KEY (workspace_id)
    )`;

  it('extracts a DDL body across nested parens like DEFAULT now()', () => {
    const bodies = sharedPresenceDdlBodies(complete);
    expect(bodies).toHaveLength(1);
    // The nested `now()` must not terminate the body early — that truncation is what
    // would make every column after last_seen_at look "missing".
    expect(bodies[0]).toContain('active_routines');
    expect(bodies[0]).toContain('PRIMARY KEY');
  });

  it('FLAGS a fixture missing the column that caused the 2026-08-02 recurrence', () => {
    const rotted = complete.replace('      active_routines text[],\n', '');
    const [body] = sharedPresenceDdlBodies(rotted);
    expect(declaresColumn(body, 'active_routines')).toBe(false);
    expect(declaresColumn(body, 'runs_routines')).toBe(true);
  });

  it('FLAGS the earlier runs_routines rot too, and is not fooled by a substring', () => {
    const [body] = sharedPresenceDdlBodies(
      complete.replace('      runs_routines boolean,\n', ''),
    );
    // `active_routines` contains "routines" but must not satisfy `runs_routines`.
    expect(declaresColumn(body, 'runs_routines')).toBe(false);
    expect(declaresColumn(body, 'active_routines')).toBe(true);
  });

  it('handles IF NOT EXISTS and multiple fixtures in one file', () => {
    const two = `${complete}\nconst other = \`CREATE TABLE IF NOT EXISTS harness_shared.shared_presence (
      workspace_id text, active_routines text[]
    )\`;`;
    expect(sharedPresenceDdlBodies(two)).toHaveLength(2);
  });
});
