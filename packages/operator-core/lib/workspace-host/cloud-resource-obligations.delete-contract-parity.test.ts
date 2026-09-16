/**
 * PIN (WI-10001673): `CLOUD_RESOURCE_DELETE_CONTRACT` restates a kind→delete-op mapping that
 * gcp-provider.ts owns.
 *
 * The obligation ledger deliberately cannot IMPORT the provider — the whole module is built on
 * a structural/duck-typed seam so wiring the ledger to a creation path can never cycle it into
 * the provider's dependency graph. That makes the mapping a second copy of a truth the provider
 * owns, which is exactly the shape the derived-truth ladder says will drift. Rung 1 (DERIVE) is
 * closed off by that seam, so this is rung 2: PIN it with a build-time divergence check.
 *
 * Read via source text on purpose. The provider's mapping lives in a `const order` array INSIDE a
 * method and in a type union — neither is importable, so a runtime import could not see either
 * one. If the provider renames a kind, adds a deletable kind, or drops a delete op, this fails
 * and the contract gets corrected instead of silently mis-addressing a delete.
 *
 * WHY IT MATTERS CONCRETELY: a kind missing from the contract classifies as
 * `unsupported-kind`, i.e. never reclaimable — so provider drift would not produce a loud error,
 * it would produce a resource that quietly bills forever. That failure is indistinguishable from
 * a clean ledger, which is the exact failure mode this ledger has already produced twice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_RESOURCE_DELETE_CONTRACT } from './cloud-resource-obligations';

const PROVIDER_PATH = join(__dirname, 'gcp-provider.ts');
const source = readFileSync(PROVIDER_PATH, 'utf8');

/** `const VM_KIND = 'vm';` → { VM_KIND: 'vm' } */
function readKindConstants(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^const ([A-Z][A-Z0-9_]*_KIND) = '([^']+)';$/gm)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** The `[VM_KIND, 'delete-instance'],` pairs of the destroy ordering array. */
function readKindToDeleteOp(text: string, kindConstants: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\[([A-Z][A-Z0-9_]*_KIND), '(delete-[a-z]+)'\]/g)) {
    const kind = kindConstants[m[1]!];
    if (kind) out[kind] = m[2]!;
  }
  return out;
}

/** The delete member of the `GcpStepInput` union. */
function readDeleteOps(text: string): Set<string> {
  return new Set([...text.matchAll(/^\s*\|?\s*'(delete-[a-z]+)'[;,]?$/gm)].map((m) => m[1]!));
}

describe('CLOUD_RESOURCE_DELETE_CONTRACT parity with gcp-provider', () => {
  const kindConstants = readKindConstants(source);
  const providerMapping = readKindToDeleteOp(source, kindConstants);
  const providerDeleteOps = readDeleteOps(source);

  it('POSITIVE CONTROL: the extraction actually found the provider mapping', () => {
    // Without this, a regex that silently stops matching turns every assertion below into a
    // vacuous pass over an empty object — a guard that cannot fail, which is worse than none.
    expect(Object.keys(kindConstants).length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(providerMapping).length).toBeGreaterThanOrEqual(7);
    expect(providerDeleteOps.size).toBeGreaterThanOrEqual(7);
    expect(kindConstants.VM_KIND).toBe('vm');
  });

  it('maps every kind to the op the provider actually uses for it', () => {
    const ours = Object.fromEntries(
      Object.entries(CLOUD_RESOURCE_DELETE_CONTRACT).map(([kind, entry]) => [kind, entry.op]),
    );
    expect(ours).toEqual(providerMapping);
  });

  it('names only ops that exist in the provider delete union', () => {
    for (const [kind, entry] of Object.entries(CLOUD_RESOURCE_DELETE_CONTRACT)) {
      expect(providerDeleteOps, `contract kind '${kind}' names op '${entry.op}'`).toContain(entry.op);
    }
  });

  it('covers every deletable kind the provider knows — a new one must not fall through as unsupported', () => {
    for (const kind of Object.keys(providerMapping)) {
      expect(
        CLOUD_RESOURCE_DELETE_CONTRACT,
        `provider can delete kind '${kind}' but the obligation contract omits it, so such a row ` +
          `would classify as unsupported-kind and never be reclaimed`,
      ).toHaveProperty(kind);
    }
  });

  it('requires a zone for zonal kinds and a region for regional kinds', () => {
    // The addressing rule the provider's delete step enforces at call time, asserted here where
    // it is cheap instead of at a live delete where it is not.
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.vm!.requires).toEqual(['zone']);
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.disk!.requires).toEqual(['zone']);
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.subnetwork!.requires).toEqual(['region']);
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.router!.requires).toEqual(['region']);
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.nat!.requires).toEqual(['region', 'parentResourceId']);
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.network!.requires).toEqual([]);
    expect(CLOUD_RESOURCE_DELETE_CONTRACT.firewall!.requires).toEqual([]);
  });
});
