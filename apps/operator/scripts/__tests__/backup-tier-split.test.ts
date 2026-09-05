import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WI-2146225 — recurrence guards for the TIERED Postgres dump.
 *
 * WHY THE SPLIT EXISTS. Measured 2026-09-05 by attributing every -Fd data member
 * of the live 93 GiB papercusp dump to its table via the archive TOC: six
 * append-only transcript/telemetry tables are 73 GiB of it (78%), and the state
 * that actually has to come back to restart the system is the other 20 GiB. So
 * the recovery-point objective of the irreplaceable state was being set by the
 * cost of dumping history we can live without.
 *
 * WHY THE SPLIT LIVES IN THE PRODUCER AND NOT IN KOPIA. It was first ratified as
 * a kopia exclusion. That is NOT EXPRESSIBLE: a -Fd dump names its data members
 * by pg_dump's internal dumpId, and dumpIds DRIFT between dump sets (measured:
 * session_archive_files was 30053 in the live set and 30016 in a frozen one,
 * +37 on every row) while only the pg OID is stable. A filename exclusion would
 * go on matching a DIFFERENT table every run, with no error anywhere.
 *
 * THE FAILURE THESE GUARD. Both hazards below are silent in BOTH directions —
 * the run exits 0, the artifact validates under `pg_restore -l`, and STATUS.json
 * is green — which is why they are pinned here rather than trusted to review:
 *
 *   1. SPLIT-BRAIN LISTS. If the exclude list and the include list are ever
 *      maintained separately, a table in NEITHER is silently in no backup at
 *      all, and a table in BOTH is stored twice. The only structural defence is
 *      that both are derived from ONE list, so that is what is asserted.
 *
 *   2. A PATTERN THAT MATCHES NOTHING. `pg_dump --exclude-table-data=<pattern>`
 *      does not error when the pattern matches nothing. One typo or one renamed
 *      table therefore leaves the 42 GiB table in the "state" tier AND drops it
 *      from the transcript tier simultaneously — un-splitting the thing while
 *      reporting success. Size cannot catch it (both tiers legitimately move run
 *      to run), so the script must verify existence up front, against the
 *      database being dumped rather than the `postgres` maintenance database
 *      (asking the wrong one reports every table missing and disables the tiers
 *      permanently — the same bug wearing the opposite mask).
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2), rather than by mutating the shared
// checkout — which git-sync would commit mid-probe.
const SCRIPT =
  process.env.BACKUP_TIER_SPLIT_SCRIPT ??
  resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

const src = readFileSync(SCRIPT, 'utf8');

/** The default value of a `VAR="${VAR:-default}"` assignment. */
function defaultOf(name: string): string | null {
  const m = src.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"`, 'm'));
  return m ? m[1] : null;
}

describe('papercusp-db-backup.sh tiered dump (WI-2146225)', () => {
  it('is the script we think it is (positive control)', () => {
    // A guard whose subject silently became the wrong file passes vacuously.
    expect(src).toContain('PC_BACKUP_TRANSCRIPT_TABLES');
    expect(src).toContain('dump_one');
  });

  it('derives BOTH tiers from a single table list, so no table can fall in the gap', () => {
    // One list variable, assigned exactly once.
    const assignments = src.match(/^PC_BACKUP_TRANSCRIPT_TABLES=/gm) ?? [];
    expect(assignments).toHaveLength(1);

    // Both tiers' pg_dump arguments are built inside one loop over that list.
    // Capturing the loop body is what makes this a structural claim rather than
    // a "both strings appear somewhere in the file" coincidence.
    const loop = src.match(
      /for t in \$PC_BACKUP_TRANSCRIPT_TABLES; do([\s\S]*?)\n {4}done/g,
    );
    expect(loop, 'expected a loop over PC_BACKUP_TRANSCRIPT_TABLES').toBeTruthy();
    const argBuildingLoop = (loop ?? []).find(
      (b) => b.includes('--exclude-table-data=') || b.includes('--table='),
    );
    expect(
      argBuildingLoop,
      'the exclude and include argument arrays must be built from the shared list',
    ).toBeTruthy();
    expect(argBuildingLoop).toContain('--exclude-table-data=$t');
    expect(argBuildingLoop).toContain('--table=$t');
  });

  it('names every default transcript table schema-qualified', () => {
    const list = defaultOf('PC_BACKUP_TRANSCRIPT_TABLES');
    expect(list, 'PC_BACKUP_TRANSCRIPT_TABLES must have a default').toBeTruthy();
    const tables = (list as string).split(/\s+/).filter(Boolean);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      // An unqualified name resolves by search_path, which pg_dump does not
      // share with this script — so it would match nothing, silently.
      expect(t, `${t} must be schema-qualified`).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/);
    }
  });

  it('verifies the configured tables EXIST before dumping, against the target database', () => {
    expect(src).toContain('to_regclass');
    // The existence probe must connect to the database being dumped. $PSQL is
    // pinned to `-d postgres`, where these tables do not exist at all.
    const probeBlock = src.slice(Math.max(0, src.indexOf('to_regclass') - 600));
    expect(
      probeBlock,
      'the existence probe must use -d "$db", not the postgres maintenance DB',
    ).toContain('-d "$db"');
    // And a missing table must STOP the tier rather than dump a mislabelled one.
    expect(probeBlock).toMatch(/if \[ -n "\$missing" \]; then/);
  });

  it('routes both tiers through dump_one so they inherit the artifact safety rails', () => {
    // dump_one carries the space precondition, the chown/chmod that keeps the
    // artifact readable by both the archiver and pg_restore, the `pg_restore -l`
    // validation, and the atomic swap that preserves last-known-good. A tier
    // that dumped directly would silently lack all of them.
    expect(src).toMatch(/dump_one "\$db" "\$db-state"/);
    expect(src).toMatch(/dump_one "\$db" "\$db-transcript"/);
  });

  it('never lets a tier failure redden the authoritative backup', () => {
    // During the additive phase the tiers are redundant copies of a dump that is
    // already green. Folding a tier failure into FAILED would raise
    // ALERT-BACKUP-FAILING on a healthy backup — the false-alarm trap the script
    // header already warns about twice.
    const tierPass = src.slice(src.indexOf('ADDITIVE PHASE'));
    expect(tierPass.length).toBeGreaterThan(0);
    expect(tierPass).toContain('TIER_FAILED+=');
    expect(
      tierPass.match(/(?<!TIER_)FAILED\+=/g),
      'the tier pass must not append to the authoritative FAILED array',
    ).toBeNull();
  });

  it('reports tier outcomes in STATUS.json under their own fields', () => {
    // A consumer must be able to assert on tier health directly instead of
    // inferring it from a whole-cluster boolean that deliberately excludes it.
    expect(src).toContain('"tierDumped"');
    expect(src).toContain('"tierFailed"');
    expect(src).toContain('"tiersEnabled"');
  });
});
