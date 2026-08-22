/** Shared runtime guard for the migration-number reservation contract. */

/** Mirrors scripts/lint-migrations.mjs's reservation-enforcement epoch. */
export const RESERVATION_ENFORCED_FROM = 494;

/** `<NNN>-<slug>.sql` → NNN, or null when the name carries no numeric prefix. */
export function migrationNumberOf(filename: string): number | null {
  const match = /^(\d+)-/.exec(filename);
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

export interface MigrationReservationRow {
  num: number;
  filename: string | null;
}

export interface MigrationReservationConflict {
  num: number;
  file: string;
  reservedFilename: string | null;
}

/** Pure filename-equality check used by boot reconciliation diagnostics. */
export function reservationFilenameConflicts(
  migrationFiles: readonly string[],
  reservations: readonly MigrationReservationRow[],
  enforcedFrom = RESERVATION_ENFORCED_FROM,
): MigrationReservationConflict[] {
  const reservedByNumber = new Map(reservations.map((row) => [Number(row.num), row.filename]));
  const conflicts: MigrationReservationConflict[] = [];
  for (const file of migrationFiles) {
    const num = migrationNumberOf(file);
    if (num === null || num < enforcedFrom || !reservedByNumber.has(num)) continue;
    const reservedFilename = reservedByNumber.get(num) ?? null;
    // Historical allocator calls without --name recorded NNN-TODO-rename.sql,
    // then authors renamed the file before apply. These inputs are APPLIED
    // filenames, so the placeholder is frozen legacy debt; the pre-apply guard
    // still rejects every NEW/pending placeholder mismatch.
    if (reservedFilename === `${String(num).padStart(3, '0')}-TODO-rename.sql`) continue;
    if (reservedFilename !== file) conflicts.push({ num, file, reservedFilename });
  }
  return conflicts;
}

/**
 * SQL embedded in db:migrate's transaction immediately before `\i`.
 * Checking only that NUM exists is insufficient: an unreserved file can hijack
 * a peer's reserved number, which is exactly how 880-session-turn-parts was
 * applied over the 880-oauth-flow-private-context reservation.
 */
export function migrationReservationGuardSql(filename: string, enforcedFrom = RESERVATION_ENFORCED_FROM): string {
  const num = migrationNumberOf(filename);
  if (num === null || num < enforcedFrom) return '';
  const expected = filename.replace(/'/g, "''");
  return (
    `DO $papercusp_migration_reservation_guard$\n` +
    `DECLARE reserved_filename text;\n` +
    `BEGIN\n` +
    `  SELECT filename INTO reserved_filename\n` +
    `    FROM harness_shared.migration_reservations WHERE num = ${num};\n` +
    `  IF reserved_filename IS NULL THEN\n` +
    `    RAISE EXCEPTION 'migration ${num} has no reservation (expected ${expected})';\n` +
    `  ELSIF reserved_filename <> '${expected}' THEN\n` +
    `    RAISE EXCEPTION 'migration ${num} is reserved for %, not ${expected}', reserved_filename;\n` +
    `  END IF;\n` +
    `END\n` +
    `$papercusp_migration_reservation_guard$;\n`
  );
}
