/** Producer declarations, not a second hand-maintained list of install paths. */
export type StateClass = 'state' | 'config' | 'secret' | 'cache' | 'dev-only';
export type CensusKind = 'path' | 'database' | 'unit' | 'secret';
export interface CensusEntry {
  kind: CensusKind;
  /** Root-qualified identity; paths from different roots must never alias. */
  root: string;
  name: string;
}
export interface CensusDeclaration extends CensusEntry {
  classification: StateClass;
  producer: string;
  /** Explicit directory ownership; false means this exact entry only. */
  descendants?: boolean;
}

function matches(entry: CensusEntry, declaration: CensusDeclaration): boolean {
  return entry.kind === declaration.kind && entry.root === declaration.root &&
    (entry.name === declaration.name ||
      (entry.kind === 'path' && declaration.descendants === true &&
        entry.name.startsWith(`${declaration.name}/`)));
}

/** Unknown or conflicting ownership is residue, never silently exportable state. */
export function generateStateCensus(
  entries: readonly CensusEntry[],
  declarations: readonly CensusDeclaration[],
) {
  const inventory = entries.map(entry => {
    const owners = declarations.filter(declaration => matches(entry, declaration));
    const classes = new Set(owners.map(owner => owner.classification));
    return {
      ...entry,
      classification: classes.size === 1 ? owners[0].classification : null,
      producers: [...new Set(owners.map(owner => owner.producer))].sort(),
      problem: owners.length === 0 ? 'unclassified' as const :
        classes.size > 1 ? 'conflicting' as const : null,
    };
  }).sort((a, b) => JSON.stringify([a.kind, a.root, a.name])
    .localeCompare(JSON.stringify([b.kind, b.root, b.name])));
  const residue = inventory.filter(entry => entry.problem !== null);
  return { inventory, residue, ok: residue.length === 0 };
}

export function assertStateCensusComplete(census: ReturnType<typeof generateStateCensus>): void {
  if (!census.ok) {
    throw new Error(`State census drift: ${census.residue.map(entry =>
      `${entry.problem}:${entry.kind}:${entry.root}:${entry.name}`).join(', ')}`);
  }
}
