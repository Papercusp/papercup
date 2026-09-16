/**
 * identities-v1 P-014 clause 2 / D-043 — the NON-ENGINEERING identity is
 * Cupboard-publishable.
 *
 * The publish gate itself was already built and already correct; what was
 * missing was the non-default SUBJECT'S ENROLMENT in it. `papercusp-engineer`
 * (the engineering identity) declared `visibility: public` and `research` did
 * not, so the fail-closed gate read the non-engineering identity as 'internal'
 * and 422'd it — the exact domain-portability asymmetry P-014 exists to
 * disprove. This pins the enrolment.
 *
 * It reads the REAL on-disk blueprint.yaml through the REAL gate, the same way
 * `POST /cupboard/publish-blueprint` does (`parseYaml` on the single concrete
 * file — the route never merges `extends`, so a marker inherited from `base`
 * would NOT be seen; it has to sit on `research/blueprint.yaml` itself).
 *
 * Three controls keep a green here from being vacuous — the failure mode this
 * file is most exposed to is passing for a reason unrelated to the marker:
 *   - DISCRIMINATION: a real unmarked blueprint must read 'internal' through the
 *     same function, so a gate stubbed to always-'public' fails here.
 *   - INSTRUMENT: the parse must yield the blueprint we think it did, so a wrong
 *     path or an empty read fails loudly instead of silently reading as absent.
 *   - PAIRING: the engineering identity must ALSO be public, so this asserts
 *     portability (both publishable) rather than a one-sided flip.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { harnessRoot } from '@papercusp/harness/paths';
import {
  assertBlueprintVisibilityPublishable,
  readBlueprintVisibility,
  BlueprintVisibilityError,
} from './publish-blueprint-visibility';

/**
 * The research blueprint's path, overridable so falsifiability can be proven by
 * mutating a COPY outside the tree (mutation-probe tier 2) rather than mutating
 * the shared checkout — where git-sync could commit the mutant mid-probe. The
 * CONTROLS deliberately keep reading the real files.
 */
function researchBlueprintPath(): string {
  return process.env.P014_RESEARCH_BLUEPRINT ?? join(harnessRoot(), 'blueprints', 'research', 'blueprint.yaml');
}

function blueprintPath(id: string): string {
  return id === 'research' ? researchBlueprintPath() : join(harnessRoot(), 'blueprints', id, 'blueprint.yaml');
}

/** Parse ONE concrete blueprint.yaml exactly as the publish route does. */
function readManifest(id: string): Record<string, unknown> {
  const parsed = parseYaml(readFileSync(blueprintPath(id), 'utf8'));
  expect(parsed, `blueprint.yaml for "${id}" did not parse to an object`).toBeTypeOf('object');
  return parsed as Record<string, unknown>;
}

describe('P-014 clause 2 — the research (non-engineering) identity is Cupboard-publishable', () => {
  it('research/blueprint.yaml is marked publishable on the CONCRETE file the route parses', () => {
    const manifest = readManifest('research');

    // INSTRUMENT control: prove we parsed the file we meant. Without this, a
    // wrong path or a zero-byte read yields `{}`, which reads as 'internal' —
    // byte-identical to a genuinely unmarked blueprint.
    expect(manifest.id).toBe('research');

    // The subject. Fails (422) if the `visibility: public` marker is removed.
    expect(assertBlueprintVisibilityPublishable('research', manifest)).toBe('public');
  });

  it('DISCRIMINATION control: an unmarked blueprint still reads internal through the same gate', () => {
    // `base` is the abstract parent research extends — never a public listing.
    // If this ever reads 'public', the gate is not discriminating and the
    // assertion above proves nothing.
    const base = readManifest('base');
    expect(base.id).toBe('base');
    expect(readBlueprintVisibility(base)).toBe('internal');
    expect(() => assertBlueprintVisibilityPublishable('base', base)).toThrow(BlueprintVisibilityError);
  });

  it('PAIRING: the engineering identity is publishable too — portability, not a one-sided flip', () => {
    const engineer = readManifest('papercusp-engineer');
    expect(engineer.id).toBe('papercusp-engineer');
    expect(readBlueprintVisibility(engineer)).toBe('public');
  });

  it('the marker is on the concrete file, not inherited — research declares it in its own bytes', () => {
    // The route reads one file with no extends merge, so an inherited marker
    // would never reach the gate. Assert the literal declaration is present in
    // research's own bytes rather than in a merged view.
    const raw = readFileSync(researchBlueprintPath(), 'utf8');
    expect(raw).toMatch(/^visibility:\s*public\s*$/m);
  });
});
