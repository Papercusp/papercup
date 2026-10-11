/**
 * P-017's manifest-to-test binding. Cases execute the migrated caller at its real dependency
 * seams; static assertions about source text do not count as a passing migration case.
 * An item enters COMPLETE_ITEMS only after every original row is covered and on the rail.
 */
export type RailMigrationOutcome =
  | { route: 'condition'; openedKeys: string[]; resolvedKeys: string[] }
  | { route: 'observation'; mechanism: string; observations: Array<{ eligible: number; applied: number; reason: string }> };

export interface RailMigrationCase {
  id: string;
  item: string;
  rowIds: string[];
  route: 'condition' | 'observation';
  mechanism?: string;
  run: () => RailMigrationOutcome | Promise<RailMigrationOutcome>;
}

export const RAIL_MIGRATION_COMPLETE_ITEMS: string[] = [];
export const RAIL_MIGRATION_CASES: RailMigrationCase[] = [];
