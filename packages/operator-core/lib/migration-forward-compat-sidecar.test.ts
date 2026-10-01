/**
 * Recurrence guard for the typed forward-compat acknowledgement sidecar.
 *
 * WHAT BROKE (EI-21539300249506308). `lint:migration-forward-compat` is
 * gate-blocking. When a migration carrying destructive DDL crossed into
 * immutability, NO route could satisfy it: the inline `-- FORWARD-COMPAT:` line
 * cannot be added (migration-immutability-guard / WI-38352 refuses any write to an
 * applied migration), parking it to `.sql.PENDING-CODE-DEPLOY` changes nothing
 * (the lint maps parked names back to their effective `.sql` name — this was
 * executed and measured, not assumed), and ENFORCE_FROM is a one-time historical
 * watermark rather than a rolling cutoff. Two individually-correct guards were
 * jointly unsatisfiable, and their intersection was a permanent red that froze
 * every agent's deploys.
 *
 * THE FIX (stable-candidate-related-gate-2026-08-23#D-092). The acknowledgement
 * moves into a typed sidecar beside the immutable migration. The sidecar is
 * MUTABLE, which is what makes it safe for the guard to fail closed on it: every
 * refusal it can produce is actionable, unlike the deadlock above.
 *
 * The direction that matters here is HONOURING something that should be refused —
 * that waves a forward-incompatible migration through a gate-blocking lint. So the
 * refusal matrix is exhaustive, and it opens with a calibration case: without one,
 * an evaluator that refuses EVERYTHING would pass every negative assertion below.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PARKED_SUFFIXES,
  SIDECAR_KEYS,
  SIDECAR_KIND,
  SIDECAR_SUFFIX,
  SIDECAR_VERSION,
  effectiveMigrationName,
  evaluateForwardCompatSidecar,
  forwardCompatReviewWarnings,
  makeAncestorResolver,
  migrationSha256,
  parseFrozenCandidateOpenedAtMs,
  sidecarNameFor,
} from '../../../scripts/check-migration-forward-compat.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SQL_DIR = join(REPO_ROOT, 'libs', 'papercusp', 'libs', 'db', 'sql');

const MIGRATION_SQL = 'DROP INDEX IF EXISTS harness_shared.some_legacy_uidx;\n';
const ARTIFACT = '900-fixture.sql';
/** Fixed so the suite never depends on today's date. */
const NOW = new Date('2026-01-01T00:00:00.000Z');

const VALID = {
  kind: SIDECAR_KIND,
  version: SIDECAR_VERSION,
  migration: ARTIFACT,
  appliedSha256: migrationSha256(MIGRATION_SQL),
  requiresDeployedCommit: 'a'.repeat(40),
  requiresDeployedNote: 'writer switched to the four-column tuple',
  rationale: 'the deployed release no longer names the dropped index in any ON CONFLICT arbiter',
  workItem: 'EI-21539300249506308',
  reviewBy: '2026-06-01',
  postDeploy: 'remove-sidecar',
};

function evaluate(
  overrides: Record<string, unknown> = {},
  options: { artifactFile?: string; sidecarText?: string | null; isAncestorOfHead?: (sha: string) => boolean | null; now?: Date } = {},
) {
  return evaluateForwardCompatSidecar({
    artifactFile: options.artifactFile ?? ARTIFACT,
    sidecarText:
      options.sidecarText !== undefined ? options.sidecarText : JSON.stringify({ ...VALID, ...overrides }),
    migrationSha: migrationSha256(MIGRATION_SQL),
    isAncestorOfHead: options.isAncestorOfHead ?? (() => true),
    now: options.now ?? NOW,
  });
}

describe('forward-compat sidecar — calibration', () => {
  it('HONOURS a fully valid sidecar', () => {
    // If this ever fails, every refusal assertion below is passing for the wrong
    // reason and proves nothing.
    const verdict = evaluate();
    expect(verdict.refusals).toEqual([]);
    expect(verdict.honored).toBe(true);
    expect(verdict.present).toBe(true);
  });

  it('treats a MISSING sidecar as an absence, not a refusal', () => {
    const verdict = evaluate({}, { sidecarText: null });
    expect(verdict).toEqual({ present: false, honored: false, refusals: [] });
  });
});

describe('forward-compat sidecar — frozen candidate review clock', () => {
  it('keeps reviewBy valid for the original freeze date after a later rerun', () => {
    const openedAtMs = Date.parse('2026-09-27T13:00:00.000Z');
    const frozenAt = parseFrozenCandidateOpenedAtMs(String(openedAtMs));
    expect(frozenAt).toEqual(new Date(openedAtMs));
    expect(parseFrozenCandidateOpenedAtMs(undefined)).toBeUndefined();

    expect(
      evaluate({ reviewBy: '2026-09-27' }, { now: frozenAt }).honored,
    ).toBe(true);
    const afterExpiry = evaluate(
      { reviewBy: '2026-09-27' },
      { now: new Date('2026-09-28T00:00:00.000Z') },
    );
    expect(afterExpiry.honored).toBe(false);
    expect(afterExpiry.refusals).toContain(
      'sidecar is stale — reviewBy 2026-09-27 has passed; renew or remove it',
    );
  });

  it('refuses malformed persisted timestamps instead of reverting to wall time', () => {
    expect(() => parseFrozenCandidateOpenedAtMs('not-a-timestamp')).toThrow(
      'frozen candidate openedAtMs must be a positive integer',
    );
  });
});

describe('forward-compat sidecar — refusal matrix', () => {
  const cases: Array<[string, () => ReturnType<typeof evaluate>]> = [
    // Ledger binding: the acknowledgement is pinned to the EXACT applied bytes.
    ['appliedSha256 that is not this migration', () => evaluate({ appliedSha256: 'b'.repeat(64) })],
    ['appliedSha256 that is not a sha256 at all', () => evaluate({ appliedSha256: 'not-a-hash' })],
    ['appliedSha256 missing', () => evaluate({ appliedSha256: undefined })],

    // Candidate binding: the compatible writer must exist in THIS tree.
    ['a required commit that is not an ancestor of HEAD', () => evaluate({}, { isAncestorOfHead: () => false })],
    ['a required commit whose ancestry cannot be determined', () => evaluate({}, { isAncestorOfHead: () => null })],
    ['a required commit that is not a 40-hex sha', () => evaluate({ requiresDeployedCommit: 'HEAD~1' })],

    // Free-form / placeholder prose — the specific weakness of the inline marker.
    ['a placeholder rationale', () => evaluate({ rationale: 'TODO' })],
    ['a whitespace-only rationale', () => evaluate({ rationale: '    ' })],
    ['a too-short rationale', () => evaluate({ rationale: 'because' })],
    ['a placeholder requiresDeployedNote', () => evaluate({ requiresDeployedNote: 'tbd' })],
    ['a work item that is not a work-item ref', () => evaluate({ workItem: 'ticket-7' })],

    // Staleness — safe to fail closed on, because the sidecar itself is editable.
    ['a reviewBy date that has passed', () => evaluate({ reviewBy: '2025-12-31' })],
    ['a reviewBy that is not a date', () => evaluate({ reviewBy: 'soon' })],

    // Shape.
    ['an unknown key', () => evaluate({ note: 'extra' })],
    ['a wrong kind', () => evaluate({ kind: 'something-else' })],
    ['a wrong version', () => evaluate({ version: 2 })],
    ['a postDeploy outside the enum', () => evaluate({ postDeploy: 'ignore-it' })],
    ['a migration name that does not match the file', () => evaluate({ migration: '901-other.sql' })],
    ['malformed JSON', () => evaluate({}, { sidecarText: '{ not json' })],
    ['a JSON array', () => evaluate({}, { sidecarText: '[]' })],
    ['JSON null', () => evaluate({}, { sidecarText: 'null' })],
  ];

  for (const [label, run] of cases) {
    it(`REFUSES ${label}`, () => {
      const verdict = run();
      expect(verdict.honored).toBe(false);
      // A refusal with no stated reason is unactionable, which is the failure this
      // whole mechanism exists to avoid.
      expect(verdict.refusals.length).toBeGreaterThan(0);
    });
  }

  // "Unapplied / editable": those artifacts can still take the inline marker, so
  // the sidecar route is not theirs.
  for (const suffix of PARKED_SUFFIXES) {
    it(`REFUSES a sidecar for a still-editable ${suffix} artifact`, () => {
      const verdict = evaluate({}, { artifactFile: `${ARTIFACT}${suffix}` });
      expect(verdict.honored).toBe(false);
      expect(verdict.refusals.join(' ')).toMatch(/editable/i);
    });
  }

  it('requires every declared key to be present', () => {
    for (const key of SIDECAR_KEYS) {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[key];
      const verdict = evaluate({}, { sidecarText: JSON.stringify(partial) });
      expect(verdict.honored, `omitting ${key} must refuse the sidecar`).toBe(false);
    }
  });
});

describe('forward-compat sidecar — effective-name mapping', () => {
  it('keys the sidecar on the ARMED .sql name for raw and parked artifacts', () => {
    const expected = `${ARTIFACT}${SIDECAR_SUFFIX}`;
    for (const artifact of [ARTIFACT, ...PARKED_SUFFIXES.map((s: string) => `${ARTIFACT}${s}`)]) {
      expect(sidecarNameFor(effectiveMigrationName(artifact))).toBe(expected);
    }
  });
});

describe('forward-compat sidecar — review-date alarm scan', () => {
  let directory: string;
  const writeSidecar = (name: string, reviewBy: string) => {
    writeFileSync(join(directory, name), JSON.stringify({ reviewBy }));
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'forward-compat-review-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('warns on the review date fourteen days ahead and ignores dates outside the window', () => {
    writeSidecar('900-near.sql.forward-compat.json', '2026-01-15');
    writeSidecar('901-later.sql.forward-compat.json', '2026-01-16');
    writeSidecar('902-not-a-sidecar.json', '2026-01-01');

    expect(forwardCompatReviewWarnings(directory, {
      now: new Date('2026-01-01T00:00:00.000Z'),
      warningDays: 14,
    })).toEqual([{
      kind: 'expiring',
      file: '900-near.sql.forward-compat.json',
      reviewBy: '2026-01-15',
    }]);
  });

  it('reports expired and invalid sidecars so their fail-closed state is visible between restarts', () => {
    writeSidecar('900-expired.sql.forward-compat.json', '2025-12-31');
    writeSidecar('901-invalid.sql.forward-compat.json', 'soon');
    writeSidecar('902-invalid-calendar-date.sql.forward-compat.json', '2025-02-31');
    writeFileSync(join(directory, '903-malformed.sql.forward-compat.json'), '{');

    expect(forwardCompatReviewWarnings(directory, {
      now: new Date('2026-01-01T00:00:00.000Z'),
      warningDays: 14,
    })).toEqual([
      { kind: 'expired', file: '900-expired.sql.forward-compat.json', reviewBy: '2025-12-31' },
      { kind: 'invalid', file: '901-invalid.sql.forward-compat.json', detail: 'reviewBy is missing or is not YYYY-MM-DD' },
      { kind: 'invalid', file: '902-invalid-calendar-date.sql.forward-compat.json', reviewBy: '2025-02-31', detail: 'reviewBy is not a real date' },
      { kind: 'invalid', file: '903-malformed.sql.forward-compat.json', detail: 'sidecar is not valid JSON' },
    ]);
  });
});

describe('forward-compat sidecar — ancestry resolver', () => {
  const resolver = (opts: { commitResolves?: boolean; mergeBaseStatus?: number | null } = {}) => {
    const { commitResolves = true, mergeBaseStatus = null } = opts;
    return makeAncestorResolver({
      exec: (_bin: string, args: string[]) => {
        if (args[0] === 'cat-file') {
          if (commitResolves) return '';
          throw Object.assign(new Error('not a valid object name'), { status: 128 });
        }
        if (mergeBaseStatus === null) return '';
        throw Object.assign(new Error('merge-base'), { status: mergeBaseStatus });
      },
    })('c'.repeat(40));
  };

  it('reports a real ancestor as true', () => expect(resolver()).toBe(true));
  it('reports git exit 1 as "not an ancestor"', () => expect(resolver({ mergeBaseStatus: 1 })).toBe(false));

  // Both of these must be UNDETERMINED (null), never a clean false. A broken
  // instrument that reads as a confident negative is how a valid sidecar gets
  // silently rejected — and how an absence claim becomes wrong.
  it('reports an unresolvable commit as undetermined', () =>
    expect(resolver({ commitResolves: false })).toBeNull());
  it('reports a broken git invocation as undetermined, not a negative', () =>
    expect(resolver({ mergeBaseStatus: 129 })).toBeNull());
});

describe('the real sidecar committed for migration 975', () => {
  const migrationName = '975-remove-owned-trigger-legacy-arbiter.sql';
  const sidecarName = sidecarNameFor(migrationName);

  it('is honoured against the real migration bytes and real git history', () => {
    const sql = readFileSync(join(SQL_DIR, migrationName), 'utf8');
    const sidecarText = readFileSync(join(SQL_DIR, sidecarName), 'utf8');

    const verdict = evaluateForwardCompatSidecar({
      artifactFile: migrationName,
      sidecarText,
      migrationSha: migrationSha256(sql),
      isAncestorOfHead: makeAncestorResolver({ exec: execFileSync, cwd: REPO_ROOT }),
      // Pinned so this assertion is about the BINDINGS, not about today's date;
      // staleness is enforced by the guard at gate time, where it belongs.
      now: new Date('2026-08-26T00:00:00.000Z'),
    });

    expect(verdict.refusals).toEqual([]);
    expect(verdict.honored).toBe(true);
  });

  it('pins the exact bytes recorded in the migration ledger', () => {
    // schema_migrations.sha256 IS sha256 of the file, so recomputing it here is
    // the ledger check — offline, with no database dependency inside the gate.
    const sql = readFileSync(join(SQL_DIR, migrationName), 'utf8');
    const doc = JSON.parse(readFileSync(join(SQL_DIR, sidecarName), 'utf8'));
    expect(doc.appliedSha256).toBe(migrationSha256(sql));
  });
});
