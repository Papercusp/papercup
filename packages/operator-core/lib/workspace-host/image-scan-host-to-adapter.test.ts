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
/** The far end of the carry chain: the type a consumer actually reads the evidence through. */
const EVIDENCE_SOURCE = fileURLToPath(new URL('./gcp-image-family.ts', import.meta.url));

/**
 * Keys of the conditional `findings` projection: each appears as `{ X: measurement.X }`.
 *
 * MATCHED WHITESPACE-INSENSITIVELY, AND THAT IS LOAD-BEARING. This pattern was once written
 * to the single-line spelling with literal spaces, which silently excused any entry a
 * formatter had wrapped:
 *
 *     ...(isPlainObject(measurement.vulnerabilityBySeverityAndEcosystem)
 *       ? {
 *           vulnerabilityBySeverityAndEcosystem:
 *             measurement.vulnerabilityBySeverityAndEcosystem,
 *         }
 *       : {}),
 *
 * That is not an exotic spelling — it is exactly what Prettier produces once
 * `X: measurement.X` passes the print width, so the fields most likely to escape the guard
 * were the ones with the longest, most specific names. A field wrapped that way vanished
 * from `emitted`, so its missing adapter reader was reported as compliance. The guard did
 * not fail; it stopped looking, which is worse, because a green run is read as proof.
 * Keep this tolerant of line breaks: the subject is the field set, never its formatting.
 */
function findingsBlock(source: string): string {
  const block = source.match(/const findings = \{[\s\S]*?\n {2}\};/);
  if (!block) {
    throw new Error('could not locate the host `findings` projection — extraction is stale, not the subject');
  }
  return block[0];
}

function findingsFields(source: string): string[] {
  return [...findingsBlock(source).matchAll(/\{\s*(\w+):\s*measurement\.\1\s*,?\s*\}/g)].map(
    (match) => match[1],
  );
}

/**
 * THE SAME FIELD SET, READ BY A DELIBERATELY DIFFERENT SHAPE — and the reason the guard above
 * can no longer narrow in silence.
 *
 * `findingsFields` reads object-literal STRUCTURE (`{ X: measurement.X }`), so it is sensitive
 * to where the braces sit. This one ignores structure entirely and reads PROPERTY ACCESS
 * (`measurement.X`), so no amount of reformatting moves a field out of its view. The two fail
 * in different directions, which is the whole point: the test below requires them to AGREE.
 *
 * That agreement is what the old vacuity control could not provide. A floor (`>= 13`) does not
 * track the subject, so it catches only a TOTALLY broken extractor; a PARTIALLY broken one sails
 * straight over it — 13 of 16 fields still clears a `>= 13` floor, and 12 of 17 was the real
 * measured miss. One extractor silently under-counting is invisible; two extractors disagreeing
 * is loud and names the field.
 *
 * Comments are stripped first: a projected field always appears in CODE, so dropping comment
 * text cannot hide a real divergence, and it stops a future prose mention of `measurement.foo`
 * from manufacturing a false one.
 */
function findingsFieldsByAccess(source: string): string[] {
  const code = findingsBlock(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...new Set([...code.matchAll(/measurement\.(\w+)/g)].map((match) => match[1]))];
}

/**
 * THE EXTRACTOR AS IT WAS ON THE DAY OF THE DEFECT, kept permanently as a control.
 *
 * Never used to derive anything — it exists so the tests below can demonstrate, against a
 * fixture rather than by mutating the shared tree, that the whitespace-literal spelling really
 * does go blind to a wrapped entry and really would be caught by the agreement check. A guard
 * that has never been shown to fail is a guard nobody has tested.
 */
function naiveFindingsFields(source: string): string[] {
  return [...findingsBlock(source).matchAll(/\{ (\w+): measurement\.\1 \}/g)].map(
    (match) => match[1],
  );
}

/**
 * One single-line entry beside one Prettier-wrapped entry — the exact mix that hid five fields
 * from the original guard. Kept as a fixture so the controls below are PURE: no mutation of the
 * scanner, which git-sync would sweep into a commit mid-run.
 */
const WRAPPED_FIXTURE = [
  'const findings = {',
  '    ...(isPlainObject(measurement.shortName) ? { shortName: measurement.shortName } : {}),',
  '    ...(isPlainObject(measurement.aFieldNameLongEnoughThatPrettierWrapsIt)',
  '      ? {',
  '          aFieldNameLongEnoughThatPrettierWrapsIt:',
  '            measurement.aFieldNameLongEnoughThatPrettierWrapsIt,',
  '        }',
  '      : {}),',
  '  };',
].join('\n');

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

  it('two differently-shaped extractors agree on the projected field set', () => {
    // The durable half of the fix for the narrowing this file already documents above. The
    // floor in the test above cannot see a PARTIAL narrowing, because a floor does not track
    // the subject; two extractors with different failure modes do. A formatter can move a
    // brace and blind the structural reader, but it cannot hide a `measurement.X` access —
    // so if these two ever disagree, one of them has stopped looking, and that is now a
    // failure that names the field instead of a green run that implies compliance.
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const structural = findingsFields(source);
    const byAccess = findingsFieldsByAccess(source);

    // Vacuity control: two extractors that both matched NOTHING would agree trivially, which
    // is the same trap one level up. Agreement only means something over a non-empty subject.
    expect(structural.length).toBeGreaterThanOrEqual(13);

    // A field read off `measurement` in this block but never projected is the original defect
    // restated — measured, then discarded — so the check is deliberately two-directional.
    expect(new Set(byAccess)).toEqual(new Set(structural));
  });

  it('CONTROL: the whitespace-literal spelling really goes blind, and the agreement check catches it', () => {
    // Proves the guard above CAN fail, without mutating the scanner: a guard never shown to
    // fail is untested, and mutating a tracked file here races git-sync's sweep.
    //
    // Calibration first — the fixture must be a block both CURRENT extractors read completely,
    // or the "naive misses one" result below would prove nothing about the extractors.
    const expected = ['aFieldNameLongEnoughThatPrettierWrapsIt', 'shortName'];
    expect([...findingsFields(WRAPPED_FIXTURE)].sort()).toEqual(expected);
    expect([...findingsFieldsByAccess(WRAPPED_FIXTURE)].sort()).toEqual(expected);

    // The defect: the historical spelling sees ONLY the single-line entry. Note what it does
    // NOT do — it does not throw, warn, or return an error. It returns a shorter list, and a
    // shorter list is read as "these are all the fields".
    expect(naiveFindingsFields(WRAPPED_FIXTURE)).toEqual(['shortName']);

    // And the payoff: had the structural extractor still been that spelling, the agreement
    // assertion in the test above would have FAILED rather than passed quietly.
    expect(new Set(naiveFindingsFields(WRAPPED_FIXTURE))).not.toEqual(
      new Set(findingsFieldsByAccess(WRAPPED_FIXTURE)),
    );
  });

  it('CONTROL: the agreement check fires against the REAL source when one extractor narrows', () => {
    // The fixture control above proves the MECHANISM. This proves the SHIPPED assertion is
    // sensitive over the actual subject — a fixture can be written to pass, the real block
    // cannot. Mutated in memory only: mutating the scanner on disk would race git-sync's
    // sweep, which commits the whole tree every few minutes.
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const victim = findingsFields(source).find((field) =>
      source.includes(`{ ${field}: measurement.${field} }`),
    );
    expect(victim, 'no single-line entry to narrow — this control has gone stale').toBeTruthy();

    // Rewrite one real projection into a spelling the STRUCTURAL reader cannot see, leaving
    // its `measurement.X` accesses untouched: precisely what a formatter did for free.
    const narrowed = source.replace(
      `{ ${victim}: measurement.${victim} }`,
      `{ ['${victim}']: measurement.${victim} }`,
    );
    // A no-op mutation would make any guard look strong; assert it actually applied.
    expect(narrowed).not.toBe(source);

    expect(findingsFields(narrowed)).not.toContain(victim);
    expect(findingsFieldsByAccess(narrowed)).toContain(victim);
    expect(new Set(findingsFieldsByAccess(narrowed))).not.toEqual(new Set(findingsFields(narrowed)));
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

  it('DECLARES every carried field on GcpImageScanEvidence, so a consumer can actually read it', () => {
    // The third hop, and the one that was silently broken until 2026-08-30.
    //
    // The guard above proves the adapter READS each field; it cannot prove a consumer can. The
    // adapter builds `const evidence: GcpImageScanEvidence = { ...(cond ? { x } : {}) }`, and a
    // CONDITIONAL SPREAD is exempt from TypeScript's excess-property check — so a field the
    // interface never declared type-checks cleanly, arrives at runtime, and is invisible to
    // every typed reader. Nothing fails; the field is simply unreadable at the far end.
    //
    // This is not a one-off that got fixed. MEASURED over the 25 most recent commits touching
    // either file, the gap had opened and been closed again at least six separate times in two
    // days, always the same way — the scanner gains a field, the interface lags behind:
    //
    //   2026-08-29T07:31Z  4 undeclared   2026-08-30T06:37Z  6 undeclared
    //   2026-08-29T17:01Z  3 undeclared   2026-08-30T10:42Z  3 undeclared
    //   2026-08-30T05:44Z  3 undeclared   2026-08-30T11:31Z  5 undeclared
    //
    // The 11:31Z set included vulnerabilityBySeverityAndEcosystem — the severity x ecosystem
    // cross-tab that D-201's entire verdict rests on, carried but untyped.
    //
    // That recurrence is the argument for deriving this check rather than remembering to update
    // a list: it is WI-1092039's defect one level up (measured on the VM, carried through the
    // adapter, still unreadable), and a hand-maintained "fields to declare" list is precisely
    // the mechanism that failed here six times.
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const evidence = readFileSync(EVIDENCE_SOURCE, 'utf8');
    const emitted = [...new Set([...returnedFields(source), ...findingsFields(source)])];

    const iface = evidence.match(/export interface GcpImageScanEvidence \{[\s\S]*?\n\}/);
    expect(iface, 'could not locate GcpImageScanEvidence — extraction is stale, not the subject')
      .toBeTruthy();
    const declared = new Set(
      [...(iface as RegExpMatchArray)[0].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]),
    );

    // Positive control: the extraction must actually find fields, or the filter below passes
    // by measuring nothing — the same vacuity trap the first test in this file guards against.
    expect(declared.size).toBeGreaterThanOrEqual(13);
    expect(declared).toContain('sbomSha256');

    const undeclared = emitted.filter((field) => !declared.has(field));
    expect(undeclared).toEqual([]);
  });
});
