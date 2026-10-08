import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  /** Rebuildable subtree represented by its root, never silently omitted. */
  prune?: boolean;
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

export interface CensusRoot {
  /** Stable producer identity, independent of machine-specific absolute path. */
  id: string;
  path: string;
}

/**
 * Walk declared roots without following symlinks or reading secret contents.
 * A failed root/catalog read rejects the census rather than fabricating coverage.
 * Host-owned catalog readers keep PG and service-manager dependencies out of backup.
 */
export async function collectStateCensus(input: {
  roots: readonly CensusRoot[];
  declarations: readonly CensusDeclaration[];
  readCatalogs: () => Promise<readonly CensusEntry[]>;
}) {
  for (const declaration of input.declarations) {
    if (declaration.prune && (declaration.kind !== 'path' ||
      declaration.descendants !== true ||
      !['cache', 'dev-only'].includes(declaration.classification))) {
      throw new Error('Census pruning requires an explicitly owned rebuildable subtree');
    }
  }
  const ids = input.roots.map(root => root.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate census root identity');
  const entries: CensusEntry[] = [];
  async function walk(root: CensusRoot, parent: string): Promise<void> {
    const children = await readdir(join(root.path, parent), { withFileTypes: true });
    for (const child of children) {
      const name = parent ? `${parent}/${child.name}` : child.name;
      entries.push({ kind: 'path', root: root.id, name });
      const owners = input.declarations.filter(declaration =>
        matches({ kind: 'path', root: root.id, name }, declaration));
      // A conflicting producer must not hide its descendants from drift checks.
      const prune = owners.length > 0 && owners.every(owner => owner.prune === true) &&
        new Set(owners.map(owner => owner.classification)).size === 1;
      if (child.isDirectory() && !prune) await walk(root, name);
    }
  }
  for (const root of input.roots) await walk(root, '');
  entries.push(...await input.readCatalogs());
  return generateStateCensus(entries, input.declarations);
}
