import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE CLASS THIS GUARDS — the same one `image-scan-guest-script.test.ts` guards one hop
 * earlier, which is the whole reason it is worth a second test rather than a second field.
 *
 * The image scan crosses TWO process boundaries, not one:
 *
 *   guest VM  --(ssh + jq document)-->  papercusp-image-scan.mjs  --(JSON)-->  the adapter
 *
 * Each hop is two halves of one document with nothing asserting they agree, so a field can
 * be computed on the VM, fail-closed validated, serialised, projected by the host — and then
 * dropped by the reader, silently, with no error anywhere. Fixing the FIRST hop (WI-1088331)
 * did nothing for the second: at that point `scanEvidence()` carried 9 of the host's fields
 * and discarded 9 more, including `candidateRootProof` and `mountedFilesystems` — the pair
 * that together distinguish "scanned clean" from "scanned the wrong filesystem and found
 * nothing" (WI-1092039).
 *
 * Enumerating known-missing fields would produce a list that rots. Deriving the expected set
 * from the host projection itself cannot: a field added to the scanner with no adapter reader
 * fails HERE, naming itself, on the run that introduces it.
 */

const SCANNER_SOURCE = fileURLToPath(new URL('../../bin/papercusp-image-scan.mjs', import.meta.url));
const ADAPTER_SOURCE = fileURLToPath(new URL('./gcp-image-family-adapter.ts', import.meta.url));

/** Keys of the conditional `findings` projection: each appears as `{ X: measurement.X }`. */
function findingsFields(source: string): string[] {
  const block = source.match(/const findings = \{[\s\S]*?\n {2}\};/);
  if (!block) {
    throw new Error('could not locate the host `findings` projection — extraction is stale, not the subject');
  }
  return [...block[0].matchAll(/\{ (\w+): measurement\.\1 \}/g)].map((match) => match[1]);
}

/** Keys of the object the host actually returns, including shorthand properties. */
function returnedFields(source: string): string[] {
  const block = source.match(/\n {2}return \{\n[\s\S]*?\n {2}\};/);
  if (!block) {
    throw new Error('could not locate the host result literal — extraction is stale, not the subject');
  }
  const fields: string[] = [];
  for (const line of block[0].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('...')) continue;
    const match = trimmed.match(/^(\w+)\s*[,:]/);
    if (match) fields.push(match[1]);
  }
  return fields;
}

describe('image scan host -> adapter field delivery', () => {
  it('the field extraction is not vacuous', () => {
    // A regex that silently matched nothing would make every assertion below pass while
    // measuring NOTHING — the exact shape that let the original defect survive. These are
    // positive controls: fields that have been in the projection since before this guard.
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const emitted = [...returnedFields(source), ...findingsFields(source)];

    expect(emitted).toContain('sbomSha256');
    expect(emitted).toContain('vulnerabilityBySeverity');
    expect(emitted).toContain('candidateRootProof');
    expect(emitted.length).toBeGreaterThanOrEqual(13);
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('has an adapter-side reader for every field the host emits', () => {
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const adapter = readFileSync(ADAPTER_SOURCE, 'utf8');
    const emitted = [...new Set([...returnedFields(source), ...findingsFields(source)])];

    // `scanEvidence()` reads the parsed document as `result`, so a carried field is exactly
    // one that appears as `result.<field>` somewhere in the adapter. A field measured on the
    // VM and then absent here is measured-and-discarded — the defect, restated as a check.
    const unread = emitted.filter((field) => !adapter.includes(`result.${field}`));
    expect(unread).toEqual([]);
  });

  it('carries the coverage pair that makes a clean scan believable', () => {
    // Singled out from the derived set above because these two are not diagnostics: without
    // them a partially mounted candidate is publishable behind a green gate (WI-1092039).
    // The derived test would catch their loss too; this one says WHY it matters when it does.
    const adapter = readFileSync(ADAPTER_SOURCE, 'utf8');
    expect(adapter).toContain('result.mountedFilesystems');
    expect(adapter).toContain('result.candidateRootProof');
  });
});
